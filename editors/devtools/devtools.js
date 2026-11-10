// The devtools page: adds the Zubra pane to the Elements panel. The pane (pane.html) does the rest.
chrome.devtools.panels.elements.createSidebarPane('Zubra', (pane) => {
  pane.setPage('pane.html');
});
