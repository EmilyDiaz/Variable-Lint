
/// <reference types="@figma/plugin-typings" />

const DEBUG = false;

figma.showUI(__html__, { width: 500, height: 400 });

// Scan reactions across all nodes on the current page.

let cachedScan: { pageSignature: string; entries: { name: string; nodeId: string; nodeName: string; variableType: string }[] } | null = null;
// Persistent cache for variable lookups across scans
const globalVariableCache: { [id: string]: { name: string; type: string } | null } = {};

async function processReactions() {
  const variableEntries: { name: string; nodeId: string; nodeName: string; variableType: string }[] = [];

  // Helper: post progress to UI
  function postProgress(stage: string, details?: any) {
    try {
      figma.ui.postMessage({ type: 'scan-progress', stage, details, pageName: figma.currentPage.name });
    } catch (e) {
      // ignore UI message errors
    }
  }

  // Iterative traversal to collect only nodes that have reactions
  const nodesWithReactions: (SceneNode & { reactions: any[] })[] = [];
  let nodeCount = 0;
  let reactionCount = 0;
  const stack: (SceneNode | PageNode)[] = [figma.currentPage];

  while (stack.length) {
    const node = stack.pop()!;
    try {
      nodeCount += 1;
      if ('reactions' in node && Array.isArray((node as any).reactions) && (node as any).reactions.length > 0) {
        reactionCount += (node as any).reactions.length;
        nodesWithReactions.push(node as SceneNode & { reactions: any[] });
      }
      if ('children' in node && Array.isArray((node as any).children)) {
        for (const child of (node as any).children) stack.push(child);
      }
    } catch (error) {
      // skip inaccessible nodes
    }
  }

  const pageSignature = `${figma.currentPage.id}|nodes:${nodeCount}|reactions:${reactionCount}`;
  if (cachedScan && cachedScan.pageSignature === pageSignature) {
    postProgress('cached');
    figma.ui.postMessage({ type: 'variable-names', entries: cachedScan.entries, pageName: figma.currentPage.name });
    return;
  }

  if (nodesWithReactions.length === 0) {
    postProgress('no-reactions');
    figma.ui.postMessage({ type: 'variable-names', entries: [], pageName: figma.currentPage.name });
    return;
  }

  postProgress('collected-nodes', { nodes: nodesWithReactions.length, reactions: reactionCount });

  // Collect variable IDs (single pass) and cache parsed matches per node
  const nodeMatchesMap = new Map<string, any[]>();
  const allVariableIds = new Set<string>();
  for (const node of nodesWithReactions) {
    const matches: any[] = [];
    for (const reaction of node.reactions) {
      const found = findActionsByType(reaction, ['CONDITIONAL', 'SET_VARIABLE']);
      matches.push(...found);
      for (const match of found) {
        if (match.type === 'SET_VARIABLE' && match.variableId) allVariableIds.add(match.variableId);
        else if (match.type === 'CONDITIONAL' && match.conditionalBlocks) {
          for (const block of match.conditionalBlocks) {
            if (block.actions) {
              for (const action of block.actions) {
                if (action.type === 'SET_VARIABLE' && action.variableId) allVariableIds.add(action.variableId);
              }
            }
            if (block.condition && block.condition.value && block.condition.value.expressionArguments) {
              for (const arg of block.condition.value.expressionArguments) {
                if (arg.type === 'VARIABLE_ALIAS' && arg.value && arg.value.id) allVariableIds.add(arg.value.id);
              }
            }
          }
        }
      }
    }
    nodeMatchesMap.set(node.id, matches);
  }

  postProgress('collected-variables', { variables: allVariableIds.size });

  // Batch fetch variables with limited concurrency
  const ids = Array.from(allVariableIds);
  const CHUNK = 20;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    await Promise.all(chunk.map(async (id) => {
      if (id in globalVariableCache) return;
      try {
        const variable = await figma.variables.getVariableByIdAsync(id);
        globalVariableCache[id] = variable ? { name: variable.name, type: variable.resolvedType } : null;
      } catch (e) {
        globalVariableCache[id] = null;
      }
    }));
    postProgress('batch-fetched', { fetched: Math.min(i + CHUNK, ids.length), total: ids.length });
  }

  // Build entries using cached variable details
  for (const node of nodesWithReactions) {
    try {
      const nodeName = (node as any).name || 'Untitled node';
      const matches = nodeMatchesMap.get(node.id) || [];
      for (const match of matches) {
        if (match.type === 'CONDITIONAL' && match.conditionalBlocks) {
          for (const block of match.conditionalBlocks) {
            if (block.actions) {
              for (const action of block.actions) {
                if (action.type === 'SET_VARIABLE' && action.variableId) {
                  const details = globalVariableCache[action.variableId] || null;
                  if (details) variableEntries.push({ name: details.name, nodeId: node.id, nodeName, variableType: details.type });
                }
              }
            }
            if (block.condition && block.condition.value && block.condition.value.expressionArguments) {
              for (const arg of block.condition.value.expressionArguments) {
                if (arg.type === 'VARIABLE_ALIAS' && arg.value && arg.value.id) {
                  const details = globalVariableCache[arg.value.id] || null;
                  if (details) variableEntries.push({ name: details.name, nodeId: node.id, nodeName, variableType: details.type });
                }
              }
            }
          }
        } else if (match.type === 'SET_VARIABLE' && match.variableId) {
          const details = globalVariableCache[match.variableId] || null;
          if (details) variableEntries.push({ name: details.name, nodeId: node.id, nodeName, variableType: details.type });
        }
      }
    } catch (e) {
      // continue on error per-node
    }
  }

  // Deduplicate by name+nodeId pair
  const seen = new Set<string>();
  const uniqueEntries = variableEntries.filter((entry) => {
    const key = entry.name + '|' + entry.nodeId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  if (pageSignature) {
    cachedScan = {
      pageSignature,
      entries: uniqueEntries
    };
  }

  figma.ui.postMessage({ type: 'variable-names', entries: uniqueEntries, pageName: figma.currentPage.name });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findActionsByType(action: any, targetTypes: string[]): any[] {
  const results: any[] = [];

  if (targetTypes.includes(action.type)) {
    results.push(action);
  }

  if (action.actions && Array.isArray(action.actions)) {
    for (const act of action.actions) {
      results.push(...findActionsByType(act, targetTypes));
    }
  }

  return results;
}

figma.ui.onmessage = async (msg: any) => {
  function isValidUIMessage(m: any): boolean {
    if (!m || typeof m !== 'object') return false;
    if (typeof m.type !== 'string') return false;
    if (m.type === 'focus-node') return typeof m.nodeId === 'string';
    return ['log-variables', 'close-plugin'].includes(m.type);
  }

  if (!isValidUIMessage(msg)) {
    if (DEBUG) console.warn('Ignored invalid UI message from UI', msg);
    return;
  }

  if (msg.type === 'log-variables') {
    await processReactions();
    return;
  }

  if (msg.type === 'focus-node') {
    if (DEBUG) console.log(`Attempting to focus on node with ID: ${msg.nodeId}`);
    try {
      const node = await figma.getNodeByIdAsync(msg.nodeId);

      if (!node) {
        console.error(`Node with ID: ${msg.nodeId} not found.`);
        return;
      }

      if ('id' in node && 'type' in node && node.type !== 'DOCUMENT' && node.type !== 'PAGE') {
        // Focus on the node without modifying its locked or visible state
        figma.currentPage.selection = [node as SceneNode];
        figma.viewport.scrollAndZoomIntoView([node as SceneNode]);
        if (DEBUG) console.log(`Successfully focused on node with ID: ${msg.nodeId}`);
      } else {
        console.error(`Cannot focus on node with ID: ${msg.nodeId}. Unsupported type: ${node.type}`);
      }
    } catch (error) {
      console.error(`Error focusing on node with ID: ${msg.nodeId}.`, error);
    }
    return;
  }

  if (msg.type === 'close-plugin') {
    figma.closePlugin();
  }
};