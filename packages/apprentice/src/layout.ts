export type GraphPositions = Readonly<Record<string, { readonly x: number; readonly y: number }>>;

export interface GraphSection {
  readonly id: string;
  readonly title: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly collapsed: boolean;
  readonly nodeIds: readonly string[];
}

export interface GraphLayout {
  readonly schemaVersion: 2;
  readonly positions: GraphPositions;
  readonly sections: readonly GraphSection[];
  readonly routeCenters?: GraphPositions;
}

export const emptyGraphLayout = (): GraphLayout => ({ schemaVersion: 2, positions: {}, sections: [] });

export function parseGraphLayout(value: unknown): GraphLayout | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as { schemaVersion?: unknown; positions?: unknown; sections?: unknown; routeCenters?: unknown };
  if (source.schemaVersion !== 1 && source.schemaVersion !== 2) return null;
  if (!source.positions || typeof source.positions !== 'object' || Array.isArray(source.positions)) return null;
  const positions: Record<string, { x: number; y: number }> = {};
  const validCoordinate = (number: unknown): number is number => typeof number === 'number' && Number.isFinite(number) && Math.abs(number) <= 100000;
  for (const [id, point] of Object.entries(source.positions)) {
    if (!point || typeof point !== 'object') continue;
    const position = point as { x?: unknown; y?: unknown };
    if (validCoordinate(position.x) && validCoordinate(position.y)) positions[id] = { x: position.x, y: position.y };
  }
  const sections: GraphSection[] = [];
  const members = new Set<string>();
  const ids = new Set<string>();
  if (source.schemaVersion === 2) {
    if (!Array.isArray(source.sections)) return null;
    for (const item of source.sections) {
      if (!item || typeof item !== 'object') return null;
      const section = item as { id?: unknown; title?: unknown; x?: unknown; y?: unknown; width?: unknown; height?: unknown; collapsed?: unknown; nodeIds?: unknown };
      if (typeof section.id !== 'string' || !section.id || ids.has(section.id) || typeof section.title !== 'string'
        || !validCoordinate(section.x) || !validCoordinate(section.y) || !validCoordinate(section.width) || !validCoordinate(section.height)
        || section.width < 240 || section.height < 140 || typeof section.collapsed !== 'boolean' || !Array.isArray(section.nodeIds)
        || !section.nodeIds.every(id => typeof id === 'string' && !members.has(id))
        || new Set(section.nodeIds).size !== section.nodeIds.length) return null;
      ids.add(section.id);
      for (const id of section.nodeIds) members.add(id);
      sections.push({ id: section.id, title: section.title, x: section.x, y: section.y, width: section.width, height: section.height, collapsed: section.collapsed, nodeIds: section.nodeIds });
    }
  }
  const routeCenters: Record<string, { x: number; y: number }> = {};
  if (source.routeCenters && typeof source.routeCenters === 'object' && !Array.isArray(source.routeCenters)) {
    for (const [id, point] of Object.entries(source.routeCenters)) {
      if (!point || typeof point !== 'object') continue;
      const center = point as { x?: unknown; y?: unknown };
      if (validCoordinate(center.x) && validCoordinate(center.y)) routeCenters[id] = { x: center.x, y: center.y };
    }
  }
  return { schemaVersion: 2, positions, sections, ...(Object.keys(routeCenters).length ? { routeCenters } : {}) };
}

export function moveNodeToSection(layout: GraphLayout, nodeId: string, sectionId: string | null): GraphLayout {
  return { ...layout, sections: layout.sections.map(section => ({ ...section, nodeIds: [
    ...section.nodeIds.filter(id => id !== nodeId), ...(section.id === sectionId ? [nodeId] : []),
  ] })) };
}

export function sectionAtPoint(layout: GraphLayout, x: number, y: number): GraphSection | undefined {
  return [...layout.sections].reverse().find(section => !section.collapsed && x >= section.x && x <= section.x + section.width && y >= section.y && y <= section.y + section.height);
}
