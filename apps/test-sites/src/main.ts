interface RowItem {
  id: number;
  name: string;
}

const page = document.body.dataset.page;

function initFormPage(): void {
  const saveBtn = document.getElementById('save-btn') as HTMLButtonElement;
  const cancelBtn = document.getElementById('cancel-btn') as HTMLButtonElement;
  const result = document.getElementById('result') as HTMLDivElement;

  const nameInput = document.getElementById('name-input') as HTMLInputElement;
  const emailInput = document.getElementById('email-input') as HTMLInputElement;
  const noteInput = document.getElementById('note-input') as HTMLTextAreaElement;

  saveBtn.addEventListener('click', () => {
    const payload = {
      name: nameInput.value,
      email: emailInput.value,
      note: noteInput.value,
      savedAt: new Date().toISOString()
    };
    localStorage.setItem('bak:lastFormPayload', JSON.stringify(payload));
    result.textContent = `Saved ${payload.name || 'Anonymous'} @ ${payload.savedAt}`;
    result.dataset.status = 'saved';
  });

  cancelBtn.addEventListener('click', () => {
    nameInput.value = '';
    emailInput.value = '';
    noteInput.value = '';
    result.textContent = 'Reset done';
    result.dataset.status = 'reset';
  });
}

function initTablePage(): void {
  const rows: RowItem[] = [
    { id: 1, name: 'Alpha' },
    { id: 2, name: 'Beta' },
    { id: 3, name: 'Gamma' }
  ];

  const tbody = document.getElementById('rows') as HTMLTableSectionElement;
  const modal = document.getElementById('modal') as HTMLDivElement;
  const modalText = document.getElementById('modal-text') as HTMLParagraphElement;
  const confirmDelete = document.getElementById('confirm-delete') as HTMLButtonElement;
  const cancelDelete = document.getElementById('cancel-delete') as HTMLButtonElement;

  let pendingDeleteId: number | null = null;

  const render = (): void => {
    tbody.innerHTML = '';
    for (const row of rows) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${row.id}</td><td>${row.name}</td><td><button data-id="${row.id}" class="danger delete-btn">删除</button></td>`;
      tbody.appendChild(tr);
    }

    tbody.querySelectorAll<HTMLButtonElement>('.delete-btn').forEach((button) => {
      button.addEventListener('click', () => {
        pendingDeleteId = Number.parseInt(button.dataset.id ?? '', 10);
        modal.style.display = 'flex';
        modalText.textContent = `确认删除 #${pendingDeleteId}?`;
      });
    });
  };

  cancelDelete.addEventListener('click', () => {
    pendingDeleteId = null;
    modal.style.display = 'none';
  });

  confirmDelete.addEventListener('click', () => {
    if (pendingDeleteId !== null) {
      const index = rows.findIndex((item) => item.id === pendingDeleteId);
      if (index >= 0) {
        rows.splice(index, 1);
      }
      pendingDeleteId = null;
      modal.style.display = 'none';
      render();
    }
  });

  render();
}

if (page === 'form') {
  initFormPage();
}

if (page === 'table') {
  initTablePage();
}
