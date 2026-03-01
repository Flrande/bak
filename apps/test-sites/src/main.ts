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

function initControlledPage(): void {
  const controlled = document.getElementById('controlled-input') as HTMLInputElement;
  const mirror = document.getElementById('controlled-mirror') as HTMLDivElement;
  const setterLog = document.getElementById('setter-log') as HTMLDivElement;
  const blockedAction = document.getElementById('blocked-action') as HTMLButtonElement;
  const cover = document.getElementById('cover') as HTMLDivElement;
  const toggleCover = document.getElementById('toggle-cover') as HTMLButtonElement;
  const result = document.getElementById('action-result') as HTMLDivElement;

  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  let instanceSetterWrites = 0;

  if (descriptor?.get && descriptor?.set) {
    Object.defineProperty(controlled, 'value', {
      configurable: true,
      get(this: HTMLInputElement) {
        return descriptor.get!.call(this) as string;
      },
      set(this: HTMLInputElement, next: string) {
        instanceSetterWrites += 1;
        setterLog.textContent = `instanceSetterWrites: ${instanceSetterWrites}`;
        this.setAttribute('data-instance-write', next);
      }
    });
  }

  controlled.addEventListener('input', () => {
    mirror.textContent = `mirror: ${controlled.value}`;
  });

  blockedAction.addEventListener('click', () => {
    result.textContent = `result: clicked @ ${Date.now()}`;
  });

  toggleCover.addEventListener('click', () => {
    cover.style.display = cover.style.display === 'none' ? 'block' : 'none';
  });
}

if (page === 'form') {
  initFormPage();
}

if (page === 'table') {
  initTablePage();
}

if (page === 'controlled') {
  initControlledPage();
}
