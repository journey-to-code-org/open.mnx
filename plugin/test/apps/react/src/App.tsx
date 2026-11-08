import { useState } from 'react';
import Rating from '../components/rating.zb';
import Card from '../components/card.zb';
import Inbox from '../components/inbox.zb';

export function App() {
  const [stars, setStars] = useState(1);
  const [items, setItems] = useState(['a', 'b']);
  Object.assign(window, { setItems });
  return (
    <>
      <Rating value={stars} onValueChange={(event) => setStars(event.detail as number)} />
      <p id="stars">{stars}</p>
      <Card heading="React">
        <h2 slot="title">Custom</h2>
        {items.map((item) => <p key={item}>{item}</p>)}
      </Card>
      <Inbox items={[{ name: 'Ada', unread: 2 }, { name: 'Linus', unread: 0 }]} />
    </>
  );
}
