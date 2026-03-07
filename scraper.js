const puppeteer = require('puppeteer');

async function scrapeAcademicManager(username, password) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--single-process',
        '--no-zygote',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--disable-translate',
        '--disable-features=TranslateUI,BlinkGenPropertyTrees',
        '--mute-audio',
        '--no-first-run',
        '--safebrowsing-disable-auto-update',
        '--disable-accelerated-2d-canvas',
        '--disable-infobars',
      ],
    });

    const page = await browser.newPage();

    // Bloquear recursos innecesarios → menos RAM y más velocidad
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media', 'other'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setViewport({ width: 1024, height: 768 });
    await page.setDefaultNavigationTimeout(60000);

    // ── 1. LOGIN ────────────────────────────────────────────────────────────
    console.log('Navegando a login...');
    await page.goto('https://ueh.academic.lat/Autenticacion.aspx', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    await page.waitForSelector('#txtUsuario', { timeout: 30000 });
    await page.type('#txtUsuario', username);
    await page.type('#txtContrasenia', password);

    await Promise.all([
      page.click('#lnkEntrar'),
      page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 })
        .catch(() => console.log('Aviso: navegación lenta tras login'))
    ]);

    if (await page.$('#txtUsuario')) {
      throw new Error('Login fallido en Academic Manager');
    }

    // ── 2. CALENDARIO ───────────────────────────────────────────────────────
    console.log('Navegando a actividades...');
    await page.goto('https://ueh.academic.lat/Alumno/AlumnoActividadesClase.aspx', {
      waitUntil: 'networkidle0',
      timeout: 60000
    });

    await page.waitForSelector('.fc-event, .fc-daygrid-event, .calendar-event', {
      timeout: 30000
    });
    await new Promise(r => setTimeout(r, 2000));

    // ── 3. CONTAR EVENTOS ───────────────────────────────────────────────────
    const eventCount = await page.evaluate(() =>
      document.querySelectorAll('.fc-event, .fc-daygrid-event, .calendar-event').length
    );

    console.log(`Encontrados ${eventCount} eventos`);
    const tasks = [];

    // ── 4. ITERAR ───────────────────────────────────────────────────────────
    for (let i = 0; i < eventCount; i++) {
      console.log(`Procesando ${i + 1}/${eventCount}...`);
      try {

        await page.evaluate((idx) => {
          const events = document.querySelectorAll('.fc-event, .fc-daygrid-event, .calendar-event');
          if (events[idx]) {
            events[idx].scrollIntoView({ block: 'center' });
            events[idx].click();
          }
        }, i);

        // Esperar modal visible por contenido
        const modalVisible = await page.waitForFunction(() => {
          const all = document.querySelectorAll('*');
          for (const el of all) {
            if (
              el.offsetParent !== null &&
              el.children.length > 0 &&
              el.innerText?.includes('Detalle de Actividad')
            ) return true;
          }
          return false;
        }, { timeout: 10000 }).catch(() => null);

        if (!modalVisible) {
          console.warn(`  ⚠ Modal no apareció (evento ${i + 1})`);
          await cerrarModal(page);
          continue;
        }

        await waitForAjaxIdle(page, 2500);

        // ── EXTRACCIÓN ──────────────────────────────────────────────────────
        const detail = await page.evaluate(() => {
          // Encontrar el contenedor del modal visible más específico
          let modal = null;
          const all = document.querySelectorAll('div, section, article');
          for (const el of all) {
            if (el.offsetParent !== null && el.innerText?.includes('Detalle de Actividad')) {
              if (!modal || el.querySelectorAll('*').length < modal.querySelectorAll('*').length) {
                modal = el;
              }
            }
          }
          if (!modal) return null;

          const fullText = modal.innerText.trim().replace(/\s+/g, ' ');

          // — Asignatura desde el header: "Detalle de Actividad - IM Control analógico"
          let category = 'General';
          const headerEl = modal.querySelector(
            '.modal-header, [class*="header"], .ui-dialog-titlebar, h5, .h-Title-S'
          );
          if (headerEl) {
            const headerText = headerEl.innerText.trim();
            const dashIdx = headerText.indexOf(' - ');
            if (dashIdx !== -1) category = headerText.substring(dashIdx + 3).trim();
          }

          // — Título: primer heading que no sea el genérico del header
          let title = 'Tarea sin título';
          for (const h of modal.querySelectorAll('h1, h2, h3, h4')) {
            const t = h.innerText.trim();
            if (t.length > 3 && !t.toLowerCase().includes('detalle de actividad')) {
              title = t;
              break;
            }
          }

          // — Fecha de entrega: DD/MM/YYYY HH:mm → YYYY-MM-DD HH:mm:ss (formato MySQL DATETIME)
          let dueDate = null;
          const dateMatches = [...fullText.matchAll(/(\d{1,2}\/\d{1,2}\/\d{4})\s+(\d{1,2}:\d{2})/g)];

          if (dateMatches.length > 0) {
            const last = dateMatches[dateMatches.length - 1];
            const [d, m, y] = last[1].split('/');
            const timePart = last[2]; // "15:00"
            dueDate = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')} ${timePart}:00`;
          }

          return { title, category, dueDate, debugSnippet: fullText.substring(0, 400) };
        });

        if (detail?.dueDate) {
          console.log(`  ✓ "${detail.title}" | ${detail.category} | ${detail.dueDate}`);
          tasks.push({
            title: detail.title,
            category: detail.category,
            dueDate: detail.dueDate,
            description: 'Sincronizado de Academic Manager'
          });
        } else {
          console.warn(`  ✗ Sin fecha. Snippet: "${detail?.debugSnippet ?? 'N/A'}"`);
        }

      } catch (err) {
        console.warn(`  Error evento ${i + 1}:`, err.message);
      } finally {
        await cerrarModal(page);
        await new Promise(r => setTimeout(r, 600));
      }
    }

    console.log(`\n✅ ${tasks.length}/${eventCount} tareas válidas`);
    return tasks;

  } catch (error) {
    console.error('Error crítico:', error);
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

// ── HELPERS ──────────────────────────────────────────────────────────────────

async function waitForAjaxIdle(page, fallbackMs = 2500) {
  try {
    await page.waitForFunction(() => {
      if (typeof Sys !== 'undefined' && Sys.WebForms?.PageRequestManager) {
        return !Sys.WebForms.PageRequestManager.getInstance().get_isInAsyncPostBack();
      }
      return true;
    }, { timeout: fallbackMs });
  } catch {
    await new Promise(r => setTimeout(r, fallbackMs));
  }
}

async function cerrarModal(page) {
  await page.evaluate(() => {
    for (const sel of [
      '[id*="lnkCerrar"]',
      '[id*="btnCerrar"]',
      '.modal-header .close',
      '.ui-dialog-titlebar-close',
      'button.close',
      '.close'
    ]) {
      const btn = document.querySelector(sel);
      if (btn && btn.offsetParent !== null) { btn.click(); return; }
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  await page.waitForFunction(() => {
    const all = document.querySelectorAll('div');
    for (const el of all) {
      if (el.offsetParent !== null && el.innerText?.includes('Detalle de Actividad')) return false;
    }
    return true;
  }, { timeout: 4000 }).catch(() => { });
}

module.exports = { scrapeAcademicManager };