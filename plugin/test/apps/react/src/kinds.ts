// A plain .ts file in a React project gets the React component too; ?element asks for the class.
import Card from '../components/card.zb';
import CardElement from '../components/card.zb?element';

export const kinds = {
  plain: typeof Card === 'object' && '$$typeof' in Card ? 'react' : typeof Card,
  element: CardElement.zubra.tag,
};
