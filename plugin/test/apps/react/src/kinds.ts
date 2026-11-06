// A plain .ts file in a React project gets the React component too; ?element asks for the class.
import Card from '../components/card.mnx';
import CardElement from '../components/card.mnx?element';

export const kinds = {
  plain: typeof Card === 'object' && '$$typeof' in Card ? 'react' : typeof Card,
  element: CardElement.mnx.tag,
};
