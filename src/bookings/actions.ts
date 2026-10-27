import {accommodationSuggestions, bookingDayDate, createTrip, dayMinutesAt, dayTimezone, flightTiming, getPlaces, isTrip, MAX_TRIP_DAYS, type Trip, type FlightSegment, type AccommodationBooking, type Activity, type Mode, type GroundMode} from '../model';

export interface FlightTarget {dayId:string;targetId:string}
export interface JourneyExpectation {fromPlaceId:string;toPlaceId:string;mode?:Mode;flightId?:string|null}
const id=()=>crypto.randomUUID();
const ground=(mode:Mode):Exclude<Mode,'flight'>=>mode==='flight'?'drive':mode;
const linked=(trip:Trip,flightId:string)=>trip.days.some(day=>day.endFlightId===flightId||day.items.some(item=>item.flightId===flightId));

/** All helpers mutate the transaction's draft; the workspace commits it atomically. */
export function unlinkFlight(trip:Trip, flightId:string) {
  for(const day of trip.days){
    if(day.endFlightId===flightId){delete day.endFlightId;day.endMode='drive';}
    for(const item of day.items){
      if(item.flightId===flightId){delete item.flightId;item.mode='drive';if(item.duration===0)item.duration=15;}
      if(item.departureForFlightId===flightId){delete item.departureForFlightId;}
    }
  }
}

function updateDepartureAnchors(trip:Trip,flight:FlightSegment){
  const timing=flightTiming(flight);
  trip.days.forEach((day,index)=>{for(const item of day.items)if(item.departureForFlightId===flight.id){
    const minute=timing.departureGoalMs===null?null:Math.round(dayMinutesAt(timing.departureGoalMs,bookingDayDate(trip,index),dayTimezone(trip,day)));
    item.duration=Math.max(5,flight.airportBufferMinutes??120);
    item.fixed=minute!==null&&minute>=0&&minute<1440?minute:null;
  }});
}

/** Preserve airport-to-airport flights while adding ground journeys at either end. */
export function setDayEndpoints(trip:Trip,dayId:string,startPlaceId:string,endPlaceId:string){
  const day=trip.days.find(value=>value.id===dayId);
  if(!day)throw Error('This day changed. Open its day plan again.');
  const places=getPlaces(trip);
  if(!Object.hasOwn(places,startPlaceId)||!Object.hasOwn(places,endPlaceId))throw Error('Choose a saved location for this day’s start and end.');
  const startChanged=(day.startPlaceId??'hotel')!==startPlaceId,endChanged=(day.endPlaceId??'hotel')!==endPlaceId;
  const firstFlightId=day.items.length?day.items[0].mode==='flight'?day.items[0].flightId:undefined:day.endMode==='flight'?day.endFlightId:undefined;
  const departureFlight=startChanged&&firstFlightId?trip.flights?.find(flight=>flight.id===firstFlightId):undefined;
  const finalFlight=endChanged&&day.endFlightId?trip.flights?.find(flight=>flight.id===day.endFlightId):undefined;
  if(startChanged&&firstFlightId&&!departureFlight||endChanged&&day.endFlightId&&!finalFlight)throw Error('A flight link changed. Review Flights & stays before editing this day.');
  if(day.items.length+Number(Boolean(departureFlight))+Number(Boolean(finalFlight))>100)throw Error('This day is full. Move a stop before adding an airport transfer.');
  if(departureFlight)day.items.unshift({aid:id(),placeId:departureFlight.fromPlaceId,duration:Math.max(5,departureFlight.airportBufferMinutes??120),fixed:null,mode:'drive',note:'Allow time for check-in and security.',departureForFlightId:departureFlight.id});
  if(finalFlight){
    day.items.push({aid:id(),placeId:finalFlight.toPlaceId,duration:0,fixed:null,mode:'flight',note:'',flightId:finalFlight.id});
    delete day.endFlightId;day.endMode='drive';
  }
  day.startPlaceId=startPlaceId;day.endPlaceId=endPlaceId;
  if(startChanged)delete day.startStayId;
  if(endChanged)delete day.endStayId;
  // A day-zone edit also changes the displayed fixed airport goal, even when
  // the endpoints stay the same. Only anchors on this day need refreshing.
  const anchors=new Set(day.items.map(item=>item.departureForFlightId).filter(Boolean));
  for(const flight of trip.flights??[])if(anchors.has(flight.id))updateDepartureAnchors(trip,flight);
}

export function linkFlight(trip:Trip,flightId:string,target:FlightTarget){
  const flight=trip.flights?.find(item=>item.id===flightId),index=trip.days.findIndex(day=>day.id===target.dayId),day=trip.days[index];
  if(!flight||!day)throw Error('This flight or day changed. Open Flights & stays again.');
  if(linked(trip,flightId))throw Error('This flight is already linked. Unlink it before choosing another position.');
  if(bookingDayDate(trip,index)!==flight.departure.date)throw Error('Link this flight on its departure date. Extend the trip first if needed.');
  const end=target.targetId===`end:${day.id}`;
  let position=end?day.items.length:day.items.findIndex(item=>`activity:${item.aid}`===target.targetId);
  if(position<0)throw Error('This stop changed. Choose its flight again.');
  if((end&&day.endFlightId)||(!end&&day.items[position].flightId))throw Error('Unlink the existing flight at this position first.');
  if(end&&!day.items.length){
    day.startPlaceId=flight.fromPlaceId;day.endPlaceId=flight.toPlaceId;
    delete day.startStayId;delete day.endStayId;
    day.timezone=flight.departure.timezone;
    const goal=flightTiming(flight).departureGoalMs;
    if(goal!==null){const minutes=dayMinutesAt(goal,bookingDayDate(trip,index),day.timezone);if(minutes>=0&&minutes<1440)day.startTime=Math.floor(minutes);}
    day.endMode='flight';day.endFlightId=flightId;
    return;
  }
  const previous=position?day.items[position-1].placeId:day.startPlaceId??'hotel';
  const inboundMode=ground(end?day.endMode:day.items[position].mode);
  if(previous!==flight.fromPlaceId){
    const departure:Activity={aid:id(),placeId:flight.fromPlaceId,duration:Math.max(5,flight.airportBufferMinutes??120),fixed:null,mode:inboundMode,note:'Allow time for check-in and security.',departureForFlightId:flightId};
    day.items.splice(position,0,departure);position++;
  }
  if(end){day.endPlaceId=flight.toPlaceId;delete day.endStayId;day.endMode='flight';day.endFlightId=flightId;}
  else if(day.items[position].placeId===flight.toPlaceId){day.items[position].mode='flight';day.items[position].flightId=flightId;}
  else day.items.splice(position,0,{aid:id(),placeId:flight.toPlaceId,duration:0,fixed:null,mode:'flight',note:'',flightId});
  updateDepartureAnchors(trip,flight);
  if(day.items.length>100)throw Error('This day is full. Move a stop before linking the flight.');
}

export function saveFlight(trip:Trip,flight:FlightSegment,target?:FlightTarget){
  const old=trip.flights?.find(item=>item.id===flight.id);
  if(old&&linked(trip,flight.id)&&(old.fromPlaceId!==flight.fromPlaceId||old.toPlaceId!==flight.toPlaceId||old.departure.date!==flight.departure.date||flight.arrival.date<trip.startDate||flight.arrival.date>bookingDayDate(trip,trip.days.length-1)))throw Error('Unlink this flight before changing its airports or departure date, or extend the trip to include its arrival date. Your existing stops will stay in the plan.');
  if(old){trip.days.forEach((day,index)=>{if(day.endFlightId!==flight.id||day.items.length||day.startPlaceId!==old.fromPlaceId)return;const previous=flightTiming(old).departureGoalMs,next=flightTiming(flight).departureGoalMs;if(previous===null||next===null)return;const date=bookingDayDate(trip,index),oldZone=dayTimezone(trip,day);if(day.startTime!==Math.floor(dayMinutesAt(previous,date,oldZone)))return;if(day.timezone===old.departure.timezone)day.timezone=flight.departure.timezone;const minute=Math.floor(dayMinutesAt(next,date,dayTimezone(trip,day)));if(minute>=0&&minute<1440)day.startTime=minute;});}
  trip.flights=[...(trip.flights??[]).filter(item=>item.id!==flight.id),structuredClone(flight)];
  updateDepartureAnchors(trip,flight);
  if(target)linkFlight(trip,flight.id,target);
}

function targetedJourney(trip:Trip,target:FlightTarget,expected?:JourneyExpectation){
  const dayIndex=trip.days.findIndex(day=>day.id===target.dayId),day=trip.days[dayIndex];
  if(!day)throw Error('This day changed. Choose its transport again.');
  const end=target.targetId===`end:${day.id}`,position=end?day.items.length:day.items.findIndex(item=>`activity:${item.aid}`===target.targetId);
  if(position<0)throw Error('This journey changed. Choose its transport again.');
  const item=end?undefined:day.items[position],fromPlaceId=position?day.items[position-1].placeId:day.startPlaceId??'hotel';
  const toPlaceId=item?.placeId??day.endPlaceId??'hotel',mode=item?.mode??day.endMode,flightId=item?.flightId??(end?day.endFlightId:undefined);
  if(expected&&(expected.fromPlaceId!==fromPlaceId||expected.toPlaceId!==toPlaceId
    ||expected.mode!==undefined&&expected.mode!==mode
    ||Object.hasOwn(expected,'flightId')&&(expected.flightId??null)!==(flightId??null)))throw Error('This journey changed while you were choosing a flight. Open its transport again.');
  return {day,dayIndex,end,position,item,fromPlaceId,toPlaceId,mode,flightId};
}

function linkTargetedJourney(trip:Trip,flightId:string,target:FlightTarget,expected?:JourneyExpectation){
  const selected=targetedJourney(trip,target,expected),{day,dayIndex,end,toPlaceId}=selected;
  const flight=trip.flights?.find(value=>value.id===flightId);
  if(!flight)throw Error('This flight changed. Choose a booking again.');
  if(bookingDayDate(trip,dayIndex)!==flight.departure.date)throw Error('Choose a flight departing on this day, or change the trip dates first.');
  if(selected.flightId===flightId)return;
  if(selected.flightId)throw Error('This journey already has a flight. Unlink it before choosing a different booking.');
  if(linked(trip,flightId))throw Error('This flight is already linked to another journey. Unlink it there before using it here.');
  let position=selected.position;
  const inboundMode=ground(selected.mode);
  if(selected.fromPlaceId!==flight.fromPlaceId){
    day.items.splice(position,0,{aid:id(),placeId:flight.fromPlaceId,duration:Math.max(5,flight.airportBufferMinutes??120),fixed:null,mode:inboundMode,note:'Allow time for check-in and security.',departureForFlightId:flight.id});position++;
  }
  if(toPlaceId===flight.toPlaceId){
    if(end){day.endMode='flight';day.endFlightId=flight.id;}
    else {day.items[position].mode='flight';day.items[position].flightId=flight.id;}
  }else{
    day.items.splice(position,0,{aid:id(),placeId:flight.toPlaceId,duration:0,fixed:null,mode:'flight',flightId:flight.id,note:''});
  }
  updateDepartureAnchors(trip,flight);
  if(day.items.length>100)throw Error('This day is full. Move a stop before adding the airport transfers.');
}

/** Transport-picker linking keeps the chosen day endpoints, stays and manual departure time. */
export function linkFlightToJourney(trip:Trip,flightId:string,target:FlightTarget,expected?:JourneyExpectation){
  const draft=structuredClone(trip);linkTargetedJourney(draft,flightId,target,expected);validateBookingLinks(draft);Object.assign(trip,draft);
}

/** Save and link as one transaction; a stale route never leaves a partially saved booking. */
export function saveFlightToJourney(trip:Trip,flight:FlightSegment,target:FlightTarget,expected?:JourneyExpectation){
  const draft=structuredClone(trip),{day}=targetedJourney(draft,target,expected),startTime=day.startTime,timezone=day.timezone;
  saveFlight(draft,flight);
  if(startTime===undefined)delete day.startTime;else day.startTime=startTime;
  if(timezone===undefined)delete day.timezone;else day.timezone=timezone;
  linkTargetedJourney(draft,flight.id,target,expected);validateBookingLinks(draft);Object.assign(trip,draft);
}

/** A mode change must not turn a generated landing/check-in marker into a made-up visit. */
export function setJourneyGroundMode(trip:Trip,target:FlightTarget,mode:GroundMode,expected?:JourneyExpectation){
  if(!['walk','transit','drive'].includes(mode))throw Error('Choose walking, public transport or driving.');
  const draft=structuredClone(trip),selected=targetedJourney(draft,target,expected),{day,item,position,flightId,end,dayIndex}=selected;
  const flight=flightId?draft.flights?.find(value=>value.id===flightId):undefined;
  if(flightId&&!flight)throw Error('The linked flight changed. Review Flights & stays first.');
  const previous=position?day.items[position-1]:undefined;
  let removeAnchor=false;
  if(flight&&previous?.departureForFlightId===flight.id){
    const goal=flightTiming(flight).departureGoalMs,minute=goal===null?null:Math.round(dayMinutesAt(goal,bookingDayDate(draft,dayIndex),dayTimezone(draft,day)));
    const fixed=minute!==null&&minute>=0&&minute<1440?minute:null;
    removeAnchor=previous.note==='Allow time for check-in and security.'&&previous.duration===Math.max(5,flight.airportBufferMinutes??120)&&previous.fixed===fixed;
    if(!removeAnchor)delete previous.departureForFlightId;
  }
  if(item&&flight&&item.duration===0){
    if(item.note||item.fixed!==null)throw Error('This airport stop has its own notes or time. Give it a visit duration before switching to ground transport.');
    const next=day.items[position+1];
    if(next?.mode==='flight'||next?.flightId||!next&&(day.endMode==='flight'||day.endFlightId))throw Error('This arrival airport connects to another flight. Keep that airport connection when changing transport.');
    day.items=day.items.filter(value=>value.aid!==item.aid&&(!removeAnchor||value.aid!==previous!.aid));
    if(next)next.mode=mode;else day.endMode=mode;
  }else{
    if(item){delete item.flightId;item.mode=mode;}else if(end){delete day.endFlightId;day.endMode=mode;}
    if(removeAnchor)day.items=day.items.filter(value=>value.aid!==previous!.aid);
  }
  validateBookingLinks(draft);Object.assign(trip,draft);
}
export function deleteFlight(trip:Trip,flightId:string){unlinkFlight(trip,flightId);trip.flights=(trip.flights??[]).filter(item=>item.id!==flightId);}

export function applyStay(trip:Trip,stayId:string,dayIds?:string[]){
  const suggestions=accommodationSuggestions(trip);
  for(const day of trip.days){if(dayIds&&!dayIds.includes(day.id))continue;const suggestion=suggestions.find(item=>item.dayId===day.id);
    if(suggestion?.startStayId===stayId){day.startStayId=stayId;day.startPlaceId=suggestion.startPlaceId;}
    if(suggestion?.endStayId===stayId){day.endStayId=stayId;day.endPlaceId=suggestion.endPlaceId;}
  }
}
export function saveStay(trip:Trip,stay:AccommodationBooking){
  trip.stays=[...(trip.stays??[]).filter(item=>item.id!==stay.id),structuredClone(stay)];
  // Refresh only previously accepted endpoints. New suggestions still need a preview.
  trip.days.forEach((day,index)=>{const date=bookingDayDate(trip,index);
    if(day.startStayId===stay.id){if(stay.checkInDate<date&&stay.checkOutDate>=date)day.startPlaceId=stay.placeId;else delete day.startStayId;}
    if(day.endStayId===stay.id){if(stay.checkInDate<=date&&stay.checkOutDate>date)day.endPlaceId=stay.placeId;else delete day.endStayId;}
  });
}
export function deleteStay(trip:Trip,stayId:string){
  trip.stays=(trip.stays??[]).filter(item=>item.id!==stayId);
  for(const day of trip.days){if(day.startStayId===stayId)delete day.startStayId;if(day.endStayId===stayId)delete day.endStayId;}
}

export function extendTripRange(trip:Trip,from:string,to:string){
  const start=from<trip.startDate?from:trip.startDate,oldEnd=bookingDayDate(trip,trip.days.length-1),end=to>oldEnd?to:oldEnd;
  const count=Math.round((Date.parse(`${end}T12:00:00Z`)-Date.parse(`${start}T12:00:00Z`))/86400000)+1;
  if(!Number.isInteger(count)||count<1||count>MAX_TRIP_DAYS)throw Error(`A trip can have up to ${MAX_TRIP_DAYS} days.`);
  const template=createTrip(trip.name,trip.destination,start,count),offset=Math.round((Date.parse(`${trip.startDate}T12:00:00Z`)-Date.parse(`${start}T12:00:00Z`))/86400000);
  trip.days=template.days.map((fresh,index)=>{const old=trip.days[index-offset];return old?{...old,label:fresh.label,date:fresh.date}:{...fresh,id:id()};});trip.startDate=start;
}


export function startFromFlightArrival(trip:Trip,flightId:string,dayId:string){
  const flight=trip.flights?.find(item=>item.id===flightId),index=trip.days.findIndex(day=>day.id===dayId),day=trip.days[index];
  if(!flight||!day||!linked(trip,flightId))throw Error('Link the flight to its departure day first.');
  const timing=flightTiming(flight),date=bookingDayDate(trip,index);
  if(timing.arrivalReadyMs===null)throw Error('Confirm the flight arrival time first.');
  const minute=Math.ceil(dayMinutesAt(timing.arrivalReadyMs,date,flight.arrival.timezone));
  if(minute<0||minute>=1440)throw Error('Choose the day when you will leave the arrival airport, allowing for your arrival buffer.');
  day.startPlaceId=flight.toPlaceId;day.startTime=minute;day.timezone=flight.arrival.timezone;delete day.startStayId;
  if(day.finishBy!=null&&day.finishBy<=minute)day.finishBy=null;
}

/** Stop changes must not silently turn a booked flight into a road journey. */
export function validateBookingLinks(trip:Trip){
  for(let index=0;index<trip.days.length;index++){const day=trip.days[index];const ids=[day.endFlightId,...day.items.map(item=>item.flightId)].filter(Boolean);if(ids.some(id=>trip.flights?.find(flight=>flight.id===id)?.departure.date!==bookingDayDate(trip,index)))throw Error('A linked flight must stay on its departure date. Unlink it in Flights & stays before moving it to another day.');}
  if(!isTrip(trip))throw Error('This change would break a flight or stay link. Unlink the booking in Flights & stays first, then change the itinerary.');
}
