
/// <reference types="@figma/plugin-typings" />

figma.showUI(__html__, { width: 500, height: 400 });

// Scan reactions across all nodes on the current page.

async function processReactions() {
  const variableEntries: { name: string; nodeId: string; nodeName: string; variableType: string }[] = [];
  const variableCache: { [id: string]: { name: string; type: string } | null } = {};

  async function getVariableDetails(id: string): Promise<{ name: string; type: string } | null> {
    if (id in variableCache) return variableCache[id];
    try {
      const variable = await figma.variables.getVariableByIdAsync(id);
      variableCache[id] = variable
        ? { name: variable.name, type: variable.resolvedType }
        : null;
    } catch (error) {
      variableCache[id] = null;
    }
    return variableCache[id];
  }

  const nodesWithReactions = figma.currentPage.findAll((node) => {
    return 'reactions' in node && Array.isArray((node as any).reactions) && (node as any).reactions.length > 0;
  });

  if (nodesWithReactions.length > 0) {
    // Capture node metadata early before async operations
    const nodeMetadata = nodesWithReactions.map((node) => ({
      id: node.id,
      name: (node as any).name || 'Untitled node',
      reactions: (node as any).reactions,
      type: (node as any).type
    }));

    await Promise.all(nodeMetadata.map(async (nodeMeta) => {
      console.log('Found node with reactions:', nodeMeta.id, 'name:', nodeMeta.name, 'type:', nodeMeta.type);
      const nodeReactions = nodeMeta.reactions;
      for (let reaction of nodeReactions) {
        const matches: any[] = [];
        for (let action of (reaction.actions || [])) {
          matches.push(...findActionsByType(action, ['CONDITIONAL', 'SET_VARIABLE']));
        }

        for (let match of matches) {
          if (match.type === 'CONDITIONAL') {
            if (match.conditionalBlocks && Array.isArray(match.conditionalBlocks)) {
              for (let block of match.conditionalBlocks) {
                if (block.actions && Array.isArray(block.actions)) {
                  const setVarActions = block.actions.filter((a: any) => a.type === 'SET_VARIABLE');
                  await Promise.all(setVarActions.map(async (action: any) => {
                    const details = await getVariableDetails(action.variableId);
                    if (details) {
                      variableEntries.push({
                        name: details.name,
                        nodeId: nodeMeta.id,
                        nodeName: nodeMeta.name,
                        variableType: details.type
                      });
                    }
                  }));
                }

                if (block.condition && block.condition.value && block.condition.value.expressionArguments) {
                  await Promise.all(block.condition.value.expressionArguments.map(async (arg: any) => {
                    if (arg.type === 'VARIABLE_ALIAS' && arg.value && arg.value.id) {
                      const details = await getVariableDetails(arg.value.id);
                      if (details) {
                        variableEntries.push({
                          name: details.name,
                          nodeId: nodeMeta.id,
                          nodeName: nodeMeta.name,
                          variableType: details.type
                        });
                      }
                    }
                  }));
                }
              }
            }
          } else if (match.type === 'SET_VARIABLE') {
            const details = await getVariableDetails(match.variableId);
            if (details) {
              variableEntries.push({
                name: details.name,
                nodeId: nodeMeta.id,
                nodeName: nodeMeta.name,
                variableType: details.type
              });
            }
          }
        }
      }
    }));
  } else {
    console.log('No reactions found on this page.');
  }

  // Deduplicate by name+nodeId pair
  const seen = new Set<string>();
  const uniqueEntries = variableEntries.filter((entry) => {
    const key = entry.name + '|' + entry.nodeId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  if (msg.type === 'log-variables') {
    await processReactions();
    return;
  }

  if (msg.type === 'focus-node') {
    console.log(`Attempting to focus on node with ID: ${msg.nodeId}`);
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
        console.log(`Successfully focused on node with ID: ${msg.nodeId}`);
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