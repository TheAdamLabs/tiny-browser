const dot = document.getElementById('dot');
const label = document.getElementById('label');

fetch('http://127.0.0.1:7331')
  .then((r) => r.json())
  .then(({ extension }) => {
    if (extension === 'connected') {
      dot.className = 'dot green';
      label.textContent = 'Connected to server';
    } else {
      dot.className = 'dot red';
      label.textContent = 'Server running, extension not connected';
    }
  })
  .catch(() => {
    dot.className = 'dot red';
    label.textContent = 'Server not running — start with: npm start';
  });
