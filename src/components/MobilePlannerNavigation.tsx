import {Bookmark,Check,ChevronDown,ChevronLeft,ChevronRight,Compass,LayoutGrid,List,Map,Plus} from 'lucide-react';
import type {Day} from '../model';
import './mobile-planner-navigation.css';

export interface MobileDayBarProps {
  days:Day[];
  currentIndex:number;
  onChoose:(index:number)=>void;
  onOpenDays:()=>void;
  view:'list'|'map';
  onViewChange:(view:'list'|'map')=>void;
  onIdeas:()=>void;
  ideaCount:number;
  hasConflict?:boolean;
}

/** The only planner navigation that stays above the itinerary on a small screen. */
export function MobileDayBar({days,currentIndex,onChoose,onOpenDays,view,onViewChange,onIdeas,ideaCount,hasConflict=false}:MobileDayBarProps) {
  const day=days[currentIndex];
  if(!day)return null;
  return <nav className="mobile-day-bar" aria-label="Day and itinerary view">
    <button type="button" className="mobile-day-icon" aria-label="Previous day" disabled={currentIndex===0} onClick={()=>onChoose(currentIndex-1)}><ChevronLeft size={20} aria-hidden="true"/></button>
    <button type="button" className="mobile-day-select" onClick={onOpenDays} aria-haspopup="dialog" aria-label={`Choose day, ${day.label}, ${day.date}${hasConflict?', conflict to review':''}`}>
      <span>{day.label}<span className="mobile-day-date"> · {day.date}</span></span><ChevronDown size={14} aria-hidden="true"/>{hasConflict&&<i className="mobile-day-conflict" aria-hidden="true"/>}
    </button>
    <button type="button" className="mobile-day-icon" aria-label="Next day" disabled={currentIndex===days.length-1} onClick={()=>onChoose(currentIndex+1)}><ChevronRight size={20} aria-hidden="true"/></button>
    <button type="button" className={`mobile-day-icon mobile-day-view ${view==='map'?'is-selected':''}`} aria-label={view==='map'?'Show itinerary list':'Show itinerary map'} title={view==='map'?'List':'Map'} onClick={()=>onViewChange(view==='map'?'list':'map')}>{view==='map'?<List size={20} aria-hidden="true"/>:<Map size={20} aria-hidden="true"/>}</button>
    <button type="button" className="mobile-day-icon mobile-day-ideas" aria-label={`Open Ideas, ${ideaCount} saved ${ideaCount===1?'place':'places'}`} title="Ideas" onClick={onIdeas}><Bookmark size={19} aria-hidden="true"/>{ideaCount>0&&<span className="mobile-ideas-count" aria-hidden="true">{ideaCount>99?'99+':ideaCount}</span>}</button>
  </nav>;
}

export interface MobileTripNavigationProps {
  active:'overview'|'day'|'today';
  onOverview:()=>void;
  onDay:()=>void;
  onToday?:()=>void;
}

export function MobileTripNavigation({active,onOverview,onDay,onToday}:MobileTripNavigationProps) {
  return <nav className="mobile-trip-navigation" aria-label="Trip views">
    <button type="button" aria-current={active==='overview'?'page':undefined} onClick={onOverview}><LayoutGrid size={20} aria-hidden="true"/><span>Trip</span></button>
    <button type="button" aria-current={active==='day'?'page':undefined} onClick={onDay}><List size={21} aria-hidden="true"/><span>Plan</span></button>
    {onToday&&<button type="button" aria-current={active==='today'?'page':undefined} onClick={onToday}><Compass size={21} aria-hidden="true"/><span>Today</span></button>}
  </nav>;
}

export interface MobileDayPickerProps {
  days:Day[];
  currentIndex:number;
  conflictIds?:string[];
  onChoose:(index:number)=>void;
  onAddDays?:()=>void;
  disabledAdd?:boolean;
}

/** Content for the existing bottom sheet, keeping day selection and adding days together. */
export function MobileDayPicker({days,currentIndex,conflictIds=[],onChoose,onAddDays,disabledAdd=false}:MobileDayPickerProps) {
  return <div className="mobile-day-picker">
    <ul aria-label="Trip days">{days.map((day,index)=><li key={day.id}>
      <button type="button" className={index===currentIndex?'is-current':''} aria-current={index===currentIndex?'date':undefined} onClick={()=>onChoose(index)}>
        <span className="mobile-picker-date"><strong>{day.label}</strong><span>{day.date}</span></span>
        <span className="mobile-picker-meta"><span>{day.items.length} {day.items.length===1?'stop':'stops'}</span>{conflictIds.includes(day.id)&&<span className="mobile-picker-conflict">Conflict</span>}</span>
        <span className="mobile-picker-check">{index===currentIndex&&<Check size={19} aria-label="Selected day"/>}</span>
      </button>
    </li>)}</ul>
    {onAddDays&&<button type="button" className="mobile-picker-add" onClick={onAddDays} disabled={disabledAdd}><Plus size={19} aria-hidden="true"/>{disabledAdd?'Day limit reached':'Add days'}</button>}
  </div>;
}
