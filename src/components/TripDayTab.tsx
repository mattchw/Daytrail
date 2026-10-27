import {useDroppable} from '@dnd-kit/core';
import {formatTime, type Day, type schedule} from '../model';
import './trip-day-tab.css';

export default function TripDayTab({day,index,active,onClick,live,hoursConflict=false,timingLoading=false}:{
  day:Day;index:number;active:boolean;onClick:()=>void;
  live?:ReturnType<typeof schedule>;hoursConflict?:boolean;timingLoading?:boolean;
}){
  const {setNodeRef,isOver}=useDroppable({id:'day:'+index,data:{type:'day',dayIdx:index}});
  const conflict=!!live?.late||hoursConflict;
  const count=`${day.items.length} ${day.items.length===1?'stop':'stops'}${conflict?' · conflict':''}`;
  const finish=active&&day.items.length>0
    ? timingLoading?'Updating finish…':!live||live.finishApprox?'Finish time unknown':`Finish ${formatTime(live.finish)}`
    : '';
  return <button ref={setNodeRef} type="button" role="tab" aria-selected={active} onClick={onClick}
    className={`day-tab ${active?'active':''} ${isOver?'is-drop-over':''}`}>
    <strong>{day.label}<span><i> · </i>{day.date}</span></strong>
    <small className={conflict?'text-warning':''}>
      <span className="day-tab-count" title={count}>{count}</span>
      <span className="day-return" title={finish||undefined} aria-hidden={!finish||undefined}>{finish||'\u00a0'}</span>
    </small>
  </button>;
}
