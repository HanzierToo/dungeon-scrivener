import { useRef, useState } from 'react';
import { BaseEdge, getBezierPath, useReactFlow, type EdgeProps } from '@xyflow/react';

type Point = { x: number; y: number };

/** Dragging the label adjusts authoring geometry. It never changes the destination. */
export function RouteEdge(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data, label, style, markerEnd } = props;
  const flow = useReactFlow();
  const [dragPoint, setDragPoint] = useState<Point | null>(null);
  const dragStart = useRef<Point | null>(null);
  const [dragging, setDragging] = useState(false);
  const [originalPath, defaultX, defaultY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const center = dragPoint ?? data?.['center'] as Point | undefined;
  const update = data?.['onCenterChange'] as (id: string, point: Point | null) => void;
  const open = data?.['onSelect'] as (id: string) => void;
  const menu = data?.['onContextMenu'] as (event: React.MouseEvent, id: string) => void;
  const x = center?.x ?? defaultX;
  const y = center?.y ?? defaultY;
  const dx = (targetX - sourceX) / 4;
  const dy = (targetY - sourceY) / 4;
  const path = center ? `M ${sourceX},${sourceY} C ${sourceX},${sourceY + 50} ${x - dx},${y - dy} ${x},${y} C ${x + dx},${y + dy} ${targetX},${targetY - 50} ${targetX},${targetY}` : originalPath;
  const width = Math.min(260, Math.max(72, String(label).length * 6.5 + 20));
  return <>
    <BaseEdge id={id} path={path} {...(style ? { style } : {})} {...(markerEnd ? { markerEnd } : {})} />
    <foreignObject className="react-flow__edge-textwrapper" x={x - width / 2} y={y - 17} width={width} height={34} style={{ overflow: 'visible' }}>
      <button type="button" className={`apprentice-route-label nodrag nopan${selected ? ' is-selected' : ''}`} aria-label={`Route action: ${String(label)}`} title={selected ? 'Drag to bend this route. Arrow keys move its center; Home resets its path.' : 'Select to edit its action and route path.'}
        onClick={event => { event.stopPropagation(); open(id); }} onContextMenu={event => { event.preventDefault(); event.stopPropagation(); menu(event, id); }}
        onPointerDown={event => { if (!selected || event.button !== 0) return; event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); dragStart.current = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }); setDragging(true); setDragPoint({ x, y }); }}
        onPointerMove={event => { if (!dragging) return; event.stopPropagation(); setDragPoint(flow.screenToFlowPosition({ x: event.clientX, y: event.clientY })); }}
        onPointerUp={event => { if (!dragging) return; event.stopPropagation(); event.currentTarget.releasePointerCapture(event.pointerId); const point = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }); setDragging(false); setDragPoint(null); if (dragStart.current && Math.hypot(point.x - dragStart.current.x, point.y - dragStart.current.y) > 3) update(id, point); dragStart.current = null; }}
        onPointerCancel={() => { setDragging(false); setDragPoint(null); }}
        onDoubleClick={event => { event.stopPropagation(); update(id, null); }}
        onKeyDown={event => { const offset = event.shiftKey ? 40 : 10; const delta = { ArrowLeft: [-offset, 0], ArrowRight: [offset, 0], ArrowUp: [0, -offset], ArrowDown: [0, offset] }[event.key]; if (delta) { event.preventDefault(); event.stopPropagation(); update(id, { x: x + delta[0]!, y: y + delta[1]! }); } else if (event.key === 'Home') { event.preventDefault(); event.stopPropagation(); update(id, null); } }}>
        {label}{selected && <span aria-hidden="true"> ◇</span>}
      </button>
    </foreignObject>
  </>;
}
