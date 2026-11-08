// No framework: the import is the element class (and defines <zb-card>).
import Card, { tag } from '../components/card.zb';

Object.assign(window, { kind: `${typeof Card} ${Card.zubra.tag} ${tag}`, ready: true });
