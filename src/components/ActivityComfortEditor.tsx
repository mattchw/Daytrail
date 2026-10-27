import type {Activity} from '../model';

export default function ActivityComfortEditor({activity,onSave}:{activity:Activity;onSave:(patch:Partial<Activity>)=>void}) {
  return <details className="comfort-editor"><summary>Meals, walking & weather</summary>
    <p>Fine-tune this visit. Estimates describe your plan, rather than tracking your steps.</p>
    <form key={JSON.stringify([activity.aid,activity.meal,activity.walkingMeters,activity.exposure])} onSubmit={event=>{
      event.preventDefault();const data=new FormData(event.currentTarget),distance=String(data.get('walking')||'');
      onSave({meal:(String(data.get('meal'))||undefined) as Activity['meal'],exposure:(String(data.get('exposure'))||undefined) as Activity['exposure'],walkingMeters:distance===''?undefined:Math.round(Number(distance)*1000)});
    }}>
      <label>Food stop<select name="meal" defaultValue={activity.meal||''}><option value="">Use available details</option><option value="meal">A meal</option><option value="snack">Coffee or a snack</option><option value="none">Not a meal</option></select></label>
      <label>Setting<select name="exposure" defaultValue={activity.exposure||''}><option value="">Use available details</option><option value="indoor">Indoors</option><option value="outdoor">Outdoors</option><option value="mixed">Indoors and outdoors</option><option value="unknown">Not sure</option></select></label>
      <label>Walking during this visit (km)<input name="walking" type="number" min="0" max="100" step="0.1" inputMode="decimal" defaultValue={activity.walkingMeters===undefined?'':activity.walkingMeters/1000} placeholder="Use estimate, if known"/></label>
      <button className="button small" type="submit">Save visit details</button>
    </form>
  </details>;
}
