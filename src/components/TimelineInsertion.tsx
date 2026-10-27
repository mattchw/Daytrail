import type {ReactNode} from 'react';
import {useDroppable} from '@dnd-kit/core';
import {Plus} from 'lucide-react';
import './timeline-insertion.css';

export interface TimelineInsertionProps {
  id: string;
  /** Interpreted by the planner when a place or activity is dropped here. */
  target: unknown;
  label: string;
  onAdd: () => void;
  onAddFree?: () => void;
  children?: ReactNode;
  disabled?: boolean;
  dragging?: boolean;
}

/** A route transition is both a precise insertion point and a generous drop target. */
export default function TimelineInsertion({id, target, label, onAdd, onAddFree, children, disabled = false, dragging = false}: TimelineInsertionProps) {
  const {setNodeRef, isOver} = useDroppable({id, data: {type: 'insertion', target, label}, disabled});
  if (disabled) return <>{children}</>;
  const actionLabel = `Add a place ${label}`.trim();
  return <div id={id} ref={setNodeRef} className={`timeline-insertion${children ? '' : ' is-standalone'}${dragging ? ' is-dragging' : ''}${isOver ? ' is-over' : ''}${onAddFree ? ' with-free-action' : ''}`}>
    <button type="button" className="timeline-insertion-button" onClick={onAdd} aria-label={actionLabel} title={actionLabel}><span aria-hidden="true"><Plus size={14}/></span></button>
    {children && <div className="timeline-insertion-content">{children}</div>}
    {onAddFree&&<button type="button" className="free-time-add" onClick={onAddFree} aria-label={'Add free time '+label}>+ Free</button>}
  </div>;
}
