const puppeteer = require('puppeteer');

async function scrapeAcademicManager(username, password) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--single-process',
        '--no-zygote', '--disable-gpu', '--disable-dev-shm-usage',
        '--disable-extensions', '--mute-audio', '--no-first-run'
      ],
    });

    const page = await browser.newPage();

    // Bloquear recursos pero permitir CSS para tener coordenadas reales
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['image', 'font', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setViewport({ width: 1280, height: 900 });
    await page.setDefaultNavigationTimeout(60000);

    // ── 1. LOGIN ────────────────────────────────────────────────────────────
    console.log('Iniciando sesión...');
    await page.goto('https://ueh.academic.lat/Autenticacion.aspx', {
      waitUntil: 'networkidle2',
      timeout: 60000
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
    await new Promise(r => setTimeout(r, 3000));

    const eventCount = await page.evaluate(() =>
      document.querySelectorAll('.fc-event, .fc-daygrid-event, .calendar-event').length
    );

    console.log(`Detectados ${eventCount} eventos. Iniciando extracción secuencial...`);
    const tasks = [];

    // ── 3. EXTRACCIÓN CON RECARGA (v13 Refresh Edition) ───────────────────
    for (let i = 0; i < eventCount; i++) {
        console.log(`Procesando ${i + 1}/${eventCount}...`);
        try {
          // RECARGA COMPLETA PARA ESTADO FRESCO (Sugerencia del usuario)
          if (i > 0) {
            await page.goto(ACTIVIDADES_URL, { waitUntil: 'networkidle2' });
            await page.waitForSelector('.fc-event, .fc-daygrid-event, .calendar-event', { timeout: 30000 });
            await new Promise(r => setTimeout(r, 2500));
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
            console.warn(`  ⚠ No se pudo localizar evento ${i + 1} tras recarga.`);
            continue;
          }

          // Clic real de ratón
          await page.mouse.click(rect.x, rect.y);
  
          // Esperar modal
          const modalSelector = '.modal-content, .ui-dialog, [id*="pnlDetalleActividad"]';
          const modalVisible = await page.waitForSelector(modalSelector, { visible: true, timeout: 10000 })
            .catch(async () => {
              console.log(`  ↻ Re-intento de clic en evento ${i + 1}...`);
              await page.mouse.click(rect.x, rect.y);
              return await page.waitForSelector(modalSelector, { visible: true, timeout: 5000 }).catch(() => null);
            });
  
          if (!modalVisible) {
            console.log(`  ✗ Tarea ${i + 1} no abrió. Saltando.`);
            continue;
          }

          // Carga AJAX interna del detalle
          await new Promise(r => setTimeout(r, 2500));
          await waitForAjaxIdle(page, 4000);

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
            const taskDate = new Date(detail.dueDate.replace(/-/g, '/')); // Compatibilidad de formato
            
            if (taskDate < now) {
              console.log(`  ⌛ Ignorada (Expirada): ${detail.title} - ${detail.dueDate}`);
            } else {
              console.log(`  ✓ OK: ${detail.title} - ${detail.dueDate}`);
              tasks.push(detail);
            }
          }

      } catch (err) {
        console.warn(`  Error en evento ${i + 1}:`, err.message);
      }
      // No necesitamos cerrar modal manualmente, la siguiente iteración recarga todo.
    }

    console.log(`\n✅ Terminado: ${tasks.length}/${eventCount} tareas únicas extraídas.`);
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