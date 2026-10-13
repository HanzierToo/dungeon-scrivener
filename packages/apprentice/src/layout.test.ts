import { describe, expect, it } from 'vitest';
import { moveNodeToSection, parseGraphLayout, sectionAtPoint } from './layout.js';

describe('graph layout', () => {
  it('reads version 1 positions without changing game data', () => {
    expect(parseGraphLayout({ schemaVersion: 1, positions: { gate: { x: 20, y: 30 } } })).toEqual({ schemaVersion: 2, positions: { gate: { x: 20, y: 30 } }, sections: [] });
  });

  it('rejects future versions and duplicated section membership', () => {
    expect(parseGraphLayout({ schemaVersion: 3, positions: {} })).toBeNull();
    expect(parseGraphLayout({ schemaVersion: 2, positions: {}, sections: [
      { id: 'one', title: 'One', x: 0, y: 0, width: 300, height: 200, collapsed: false, nodeIds: ['gate', 'gate'] },
    ] })).toBeNull();
  });

  it('assigns a node to one section and chooses the topmost overlapping section', () => {
    const layout = parseGraphLayout({ schemaVersion: 2, positions: {}, sections: [
      { id: 'one', title: 'One', x: 0, y: 0, width: 300, height: 200, collapsed: false, nodeIds: ['gate'] },
      { id: 'two', title: 'Two', x: 20, y: 20, width: 300, height: 200, collapsed: false, nodeIds: [] },
    ] })!;
    expect(sectionAtPoint(layout, 50, 50)?.id).toBe('two');
    const moved = moveNodeToSection(layout, 'gate', 'two');
    expect(moved.sections.map(section => section.nodeIds)).toEqual([[], ['gate']]);
  });
});
