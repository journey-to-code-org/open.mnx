// The one script on the page: "Copy" buttons for the install command. Without JavaScript the
// buttons stay hidden and the command is still on the page to select.
for (const button of document.querySelectorAll('[data-copy]')) {
  button.hidden = false;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = 'Copied!';
      setTimeout(() => (button.textContent = 'Copy'), 1500);
    } catch {
      button.textContent = 'Select it instead';
    }
  });
}
