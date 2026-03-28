const puppeteer = require('puppeteer');

const MAX_EVENTS_PER_SYNC = parseInt(process.env.ACADEMIC_MAX_EVENTS || '3', 10);
const PRELOAD_WAIT_MS = parseInt(process.env.ACADEMIC_PRELOAD_WAIT_MS || '1500', 10);
const MODAL_WAIT_MS = parseInt(process.env.ACADEMIC_MODAL_WAIT_MS || '1500', 10);
const BLOCK_STYLES = process.env.ACADEMIC_BLOCK_STYLES === 'true';

async function scrapeAcademicManager(username, password) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        '--no-zygote', '--disable-gpu', '--disable-dev-shm-usage',
        '--disable-extensions', '--mute-audio', '--no-first-run',
        '--disable-background-networking', '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows', '--disable-breakpad',
        '--disable-component-update', '--disable-default-apps',
        '--disable-domain-reliability', '--disable-sync', '--no-default-browser-check',
        '--disable-software-rasterizer', '--disable-renderer-backgrounding',
        '--disable-client-side-phishing-detection', '--disable-popup-blocking',
        '--eager-logging', '--v8-cache-options=off'
      ],
    });

    const page = await browser.newPage();
    await page.setCacheEnabled(false);

    // Bloquear recursos pero permitir CSS para tener coordenadas reales
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const blockedTypes = BLOCK_STYLES
        ? ['image', 'font', 'media', 'stylesheet']
        : ['image', 'font', 'media'];

      if (blockedTypes.includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setViewport({ width: 1280, height: 900 });
    await page.setDefaultNavigationTimeout(30000);
    await page.setDefaultTimeout(30000);

    // ── 1. LOGIN ────────────────────────────────────────────────────────────
    console.log('Iniciando sesión...');
    await page.goto('https://ueh.academic.lat/Autenticacion.aspx', {
      waitUntil: 'networkidle2',
      timeout: 40000
    });

    await page.waitForSelector('#txtUsuario', { timeout: 30000 });
    await page.type('#txtUsuario', username);
    await page.type('#txtContrasenia', password);

    await Promise.all([
      page.click('#lnkEntrar'),
      page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 }).catch(() => {})
    ]);

    if (await page.$('#txtUsuario')) throw new Error('Login fallido');

    // ── 2. OBTENER CONTEO INICIAL ───────────────────────────────────────────
    const ACTIVIDADES_URL = 'https://ueh.academic.lat/Alumno/AlumnoActividadesClase.aspx';
    console.log('Obteniendo lista de tareas...');
    await page.goto(ACTIVIDADES_URL, { waitUntil: 'networkidle2' });
    await page.waitForSelector('.fc-event, .fc-daygrid-event, .calendar-event', { timeout: 30000 });
    await new Promise(r => setTimeout(r, PRELOAD_WAIT_MS));

    const eventCount = await page.evaluate(() =>
      document.querySelectorAll('.fc-event, .fc-daygrid-event, .calendar-event').length
    );

    const eventsToProcess = Math.min(eventCount, MAX_EVENTS_PER_SYNC);
    const startIndex = Math.max(0, eventCount - eventsToProcess);
    console.log(`Detectados ${eventCount} eventos. Procesando últimas ${eventsToProcess} (más recientes) para evitar sobrecarga.`);
    const tasks = [];

    // ── 3. EXTRACCIÓN CON RECARGA (v13 Refresh Edition) ───────────────────
    for (let i = startIndex; i < eventCount; i++) {
      const taskNum = i - startIndex + 1;
      console.log(`Procesando ${taskNum}/${eventsToProcess}...`);
        try {
          // RECARGA COMPLETA PARA ESTADO FRESCO (Sugerencia del usuario)
          // Solo recarga si no es el primer evento que procesamos (no el primer del rango)
          if (i !== startIndex) {
            await page.goto(ACTIVIDADES_URL, { waitUntil: 'networkidle2', timeout: 35000 });
            await page.waitForSelector('.fc-event, .fc-daygrid-event, .calendar-event', { timeout: 25000 });
            await new Promise(r => setTimeout(r, PRELOAD_WAIT_MS));
          }

          // Obtener coordenadas del evento i
          const rect = await page.evaluate((idx) => {
            const ev = document.querySelectorAll('.fc-event, .fc-daygrid-event, .calendar-event')[idx];
            if (ev) {
              ev.scrollIntoView({ block: 'center', behavior: 'instant' });
              const r = ev.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }
            return null;
          }, i);

          if (!rect) {
            console.warn(`  ⚠ No se pudo localizar evento ${taskNum} tras recarga.`);
            continue;
          }

          // Clic real de ratón
          await page.mouse.click(rect.x, rect.y);
  
          // Esperar modal
          const modalSelector = '.modal-content, .ui-dialog, [id*="pnlDetalleActividad"]';
          const modalVisible = await page.waitForSelector(modalSelector, { visible: true, timeout: 10000 })
            .catch(async () => {
              console.log(`  ↻ Re-intento de clic en evento ${taskNum}...`);
              await page.mouse.click(rect.x, rect.y);
              return await page.waitForSelector(modalSelector, { visible: true, timeout: 5000 }).catch(() => null);
            });
  
          if (!modalVisible) {
            console.log(`  ✗ Tarea ${taskNum} no abrió. Saltando.`);
            continue;
          }

          // Carga AJAX interna del detalle
          await new Promise(r => setTimeout(r, MODAL_WAIT_MS));
          await waitForAjaxIdle(page, 3000);

          // Extraer datos (Pinpoint v14)
          const detail = await page.evaluate(() => {
            const modal = document.querySelector('[id*="pnlDetalleActividad"]') || 
                          document.querySelector('.modal-content') || 
                          document.querySelector('.ui-dialog');
            if (!modal) return null;

            const fullText = (modal.innerText || "").trim().replace(/\s+/g, ' ');
            
            let category = "General";
            const asigEl = modal.querySelector('.hAsignatura') || modal.querySelector('h5');
            if (asigEl) category = asigEl.innerText.trim();

            let title = "Tarea sin título";
            const actEl = modal.querySelector('.hActividad') || modal.querySelector('h2');
            if (actEl) title = actEl.innerText.replace(/"/g, '').trim();

            let description = "Sincronizado de Academic Manager";
            const descEl = modal.querySelector('.descripActividad') || modal.querySelector('p');
            if (descEl) description = descEl.innerText.trim();

            let dueDate = null;
            const dateMatch = fullText.match(/(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})/);
            if (dateMatch) {
              const [_, dStr, tStr] = dateMatch;
              const [d, m, y] = dStr.split('/');
              dueDate = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')} ${tStr}:00`;
            }

            return { title, category, dueDate, description };
          });

          if (detail && detail.dueDate) {
            // ── FILTRO DE EXPIRACIÓN (v14) ──────────────────────────────────
            const now = new Date();
            const taskDate = new Date(detail.dueDate.replace(/-/g, '/')); 
            const TWELVE_HOURS = 12 * 60 * 60 * 1000;
            
            if (taskDate < (now.getTime() - TWELVE_HOURS)) {
              console.log(`  ⌛ Ignorada (Expirada >12h): ${detail.title} - ${detail.dueDate}`);
            } else {
              console.log(`  ✓ OK${taskDate < now ? ' (Expirada grace period)' : ''}: ${detail.title} - ${detail.dueDate}`);
              tasks.push(detail);
            }
          }

      } catch (err) {
        console.warn(`  Error en evento ${taskNum}:`, err.message);
      }
      // No necesitamos cerrar modal manualmente, la siguiente iteración recarga todo.

      // Breve pausa para bajar picos de CPU/RAM en instancias pequeñas.
      await new Promise(r => setTimeout(r, 50));
    }

    console.log(`\n✅ Terminado: ${tasks.length}/${eventsToProcess} tareas extraídas.`);
    return tasks;

  } catch (error) {
    console.error('Error crítico:', error);
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

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

module.exports = { scrapeAcademicManager };