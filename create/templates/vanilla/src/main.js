import './components/hello-counter.mnx';

// The element is a standard custom element: listen for its events like any other.
const counter = document.querySelector('hello-counter');
counter.addEventListener('countchange', (event) => {
  document.querySelector('#seen').textContent = event.detail;
});
