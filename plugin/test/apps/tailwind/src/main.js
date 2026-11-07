// The components first, so their CSS comes before Tailwind's in the bundle: layer order must
// still put Tailwind's base before components and utilities after.
import '../components/tw-card.mnx';
import '../components/sass-note.mnx';
import './app.css';

window.ready = true;
