import type { NodeDefinition, WorldDocument } from '@dungeon-scrivener/model';

export interface GraphNode {
  readonly id: string;
  readonly title: string;
  readonly visitable: boolean;
  readonly parentId: string | null;
}

export interface GraphViewModel {
  readonly nodes: readonly GraphNode[];
  readonly containment: readonly { readonly id: string; readonly parentId: string; readonly childId: string }[];
  readonly navigation: readonly { readonly id: string; readonly fromNodeId: string; readonly toNodeId: string }[];
}

function titleText(node: NodeDefinition): string {
  return node.title.kind === 'literal' ? node.title.text : node.title.key;
}

export function projectGraph(world: WorldDocument): GraphViewModel {
  return {
    nodes: world.nodes.map((node) => ({ id: node.id, title: titleText(node), visitable: node.visitable, parentId: node.parentId })),
    containment: world.nodes.flatMap((node) => node.parentId === null ? [] : [{ id: `contains:${node.parentId}:${node.id}`, parentId: node.parentId, childId: node.id }]),
    navigation: world.navigationEdges.map((edge) => ({ id: edge.id, fromNodeId: edge.fromNodeId, toNodeId: edge.toNodeId })),
  };
}
