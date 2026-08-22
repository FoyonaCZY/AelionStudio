import { Studio } from './studio.js';
import './style.css';

const studio = new Studio();
void studio.start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Studio 启动失败';
  for (const status of document.querySelectorAll('#status, #home-status')) {
    status.textContent = message;
    status.classList.add('error');
  }
});
