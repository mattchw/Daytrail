import type {KeyboardCoordinateGetter} from '@dnd-kit/core';

/** Navigate real insertion points, including when the dragged Idea is not sortable. */
export const timelineKeyboardCoordinates: KeyboardCoordinateGetter = (event, {context}) => {
  const vertical = event.code === 'ArrowUp' || event.code === 'ArrowDown';
  const horizontal = event.code === 'ArrowLeft' || event.code === 'ArrowRight';
  if (!vertical && !horizontal) return undefined;
  const {active, collisionRect, droppableContainers, droppableRects, over} = context;
  if (!active || !collisionRect) return undefined;
  event.preventDefault();

  const currentX = collisionRect.left + collisionRect.width / 2;
  const currentY = collisionRect.top + collisionRect.height / 2;
  const positive = event.code === 'ArrowDown' || event.code === 'ArrowRight';
  const candidates = droppableContainers.getEnabled().flatMap(container => {
    const type = container.data.current?.type;
    if (container.disabled || container.id === active.id || container.id === over?.id
      || !['insertion', 'day', 'ideas'].includes(type)) return [];
    const rect = droppableRects.get(container.id);
    if (!rect || rect.width <= 0 || rect.height <= 0
      || ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) return [];
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const primary = vertical ? y - currentY : x - currentX;
    const cross = vertical ? x - currentX : y - currentY;
    if (positive ? primary <= 0.5 : primary >= -0.5) return [];
    return [{type, x, y, score: Math.abs(primary) + Math.abs(cross) * 2}];
  });
  // Up/down follows the itinerary; left/right can reach day tabs or the Ideas tray.
  const preferred = candidates.filter(candidate => vertical ? candidate.type === 'insertion' : candidate.type !== 'insertion');
  const target = (preferred.length ? preferred : candidates).sort((a, b) => a.score - b.score)[0];
  if (!target) return undefined;
  // Closest-center collision detection must see the small gap, not the next card.
  return {x: target.x - collisionRect.width / 2, y: target.y - collisionRect.height / 2};
};
