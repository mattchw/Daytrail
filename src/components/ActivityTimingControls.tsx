import {Lock, Minus, Plus} from 'lucide-react';
import {formatDuration, formatTime, type Activity} from '../model';
import './activity-timing-controls.css';

export default function ActivityTimingControls({activity, start, onAdjustDuration, onChange}: {
  activity: Activity;
  start: number;
  onAdjustDuration: (delta: number, control: HTMLButtonElement) => void;
  onChange: (patch: Partial<Activity>, label: string) => void;
}) {
  return <div className="activity-timing-controls">
    <div className="editor-row"><span>Duration</span>
      <div className="stepper duration-stepper">
        <button type="button" onClick={event => onAdjustDuration(-15, event.currentTarget)} disabled={activity.duration <= 15} aria-label="Shorten by 15 minutes"><Minus size={15}/></button>
        <output aria-label="Visit duration" aria-live="polite" aria-atomic="true">{formatDuration(activity.duration)}</output>
        <button type="button" onClick={event => onAdjustDuration(15, event.currentTarget)} disabled={activity.duration >= 1440} aria-label="Lengthen by 15 minutes"><Plus size={15}/></button>
      </div>
    </div>
    <div className="editor-row"><span>Timing</span><div className="segmented">
      <button type="button" aria-pressed={activity.fixed === null} onClick={() => onChange({fixed: null}, 'Activity is now flexible')}>Flexible</button>
      <button type="button" aria-pressed={activity.fixed !== null} onClick={() => {
        if (activity.fixed === null) onChange({fixed: Math.min(1425, Math.round(start / 15) * 15)}, 'Fixed booking time set');
      }}><Lock size={11}/>Fixed time</button>
    </div></div>
    {activity.fixed !== null && <label className="editor-row"><span>Booking</span><input className="time-input" type="time" aria-label="Booking time" value={formatTime(activity.fixed)} onInput={event => {
      if (event.currentTarget.value) {
        const [hours, minutes] = event.currentTarget.value.split(':').map(Number);
        onChange({fixed: hours * 60 + minutes}, 'Booking time updated');
      }
    }}/></label>}
  </div>;
}
