import {useEffect, useRef, useState} from 'react';
import {Camera, Landmark, MapPin, Utensils} from 'lucide-react';
import {fetchItineraryPhoto, getDiscoveryPhotoURL, type DiscoveryPhoto} from '../discoveryData';
import type {Category} from '../model';
import {useConnectivity} from '../offline/connectivity';
import './itinerary-place-photo.css';

interface PhotoState {id?: string; photo?: DiscoveryPhoto; url?: string; loaded?: boolean; failed?: boolean}

/** Resolve only visible place photos; they never become part of a saved trip. */
export function useItineraryPlacePhoto(googleId?: string) {
  const host = useRef<HTMLSpanElement>(null);
  const online = useConnectivity();
  const [state, setState] = useState<PhotoState>({});
  const current = state.id === googleId ? state : {};

  useEffect(() => {
    let active = true;
    if (!googleId || !online || current.url && !current.failed) return;
    const reveal = async () => {
      try {
        const photo = await fetchItineraryPhoto(googleId);
        if (!active) return;
        const url = photo && getDiscoveryPhotoURL(photo, 240);
        setState({id: googleId, photo, url});
      } catch {
        if (active) setState({id: googleId, failed: true});
      }
    };
    if (!host.current || typeof IntersectionObserver === 'undefined') {
      void reveal();
      return () => {active = false;};
    }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        observer.disconnect();
        void reveal();
      }
    }, {rootMargin: '100px', threshold: 0.01});
    observer.observe(host.current);
    return () => {active = false; observer.disconnect();};
    // Load once per place/connection; image load/error must not restart a request.
  }, [googleId, online]);

  const displayed = !!current.url && !!current.loaded && !current.failed;
  return {
    host, url: current.failed ? undefined : current.url,
    photo: displayed ? current.photo : undefined, displayed,
    onLoad: () => setState(value => value.id === googleId ? {...value, loaded: true} : value),
    onError: () => setState(value => value.id === googleId ? {...value, failed: true} : value),
  };
}

export function ItineraryPlacePhoto({photo, category}: {
  photo: ReturnType<typeof useItineraryPlacePhoto>; category: Category;
}) {
  const Icon = category === 'food' ? Utensils : category === 'attr' ? Landmark : MapPin;
  return <span ref={photo.host} className={`itinerary-place-photo ${photo.displayed ? 'is-loaded' : ''}`}>
    <span className="itinerary-photo-fallback" aria-hidden="true"><Icon size={24}/></span>
    {photo.url && <img key={photo.url} src={photo.url} alt="" width={68} height={68}
      loading="lazy" decoding="async" onLoad={photo.onLoad} onError={photo.onError}/>}
  </span>;
}

/** Credit links stay outside the card's expand button. */
export function ItineraryPhotoCredit({photo}: {photo?: DiscoveryPhoto}) {
  if (!photo) return null;
  return <div className="itinerary-photo-credit"><Camera size={11} aria-hidden="true"/><span>
    {photo.authors.map((author, index) => <span key={`${author.name}-${index}`}>
      {index > 0 ? ', ' : ''}{author.uri
        ? <a href={author.uri} target="_blank" rel="noreferrer">{author.name}</a>
        : author.name}
    </span>)}{photo.authors.length > 0 && <span aria-hidden="true"> · </span>}
    <span className="itinerary-photo-provider">Google Maps</span>
  </span></div>;
}
