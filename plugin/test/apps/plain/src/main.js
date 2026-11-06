// No framework: the import is the element class (and defines <mnx-card>).
import Card, { tag } from '../components/card.mnx';

Object.assign(window, { kind: `${typeof Card} ${Card.mnx.tag} ${tag}`, ready: true });
