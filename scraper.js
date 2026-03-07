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

    // Bloquear recursos pesados pero PERMITIR CSS para que el calendario tenga dimensiones reales
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font', 'media'].includes(type)) { // Permitimos 'stylesheet'
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.setViewport({ width: 1280, height: 900 });
    await page.setDefaultNavigationTimeout(60000);

    // ── 1. LOGIN ────────────────────────────────────────────────────────────
    console.log('Navegando a login...');
    await page.goto('https://ueh.academic.lat/Autenticacion.aspx', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    await page.waitForSelector('#txtUsuario', { timeout: 30000 });
    await page.type('#txtUsuario', username);
    await page.type('#txtContrasenia', password);

    console.log('Haciendo clic en Entrar...');
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
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    console.log('Esperando eventos...');
    await page.waitForSelector('.fc-event, .fc-daygrid-event, .calendar-event', {
      timeout: 30000
    }).catch(() => console.log("Aviso: No se vieron eventos de inmediato."));
    
    await new Promise(r => setTimeout(r, 4000)); // Esperar a que el calendario se asiente COMPLETAMENTE

    // ── 3. CONTAR EVENTOS ───────────────────────────────────────────────────
    const eventCount = await page.evaluate(() =>
      document.querySelectorAll('.fc-event, .fc-daygrid-event, .calendar-event').length
    );

    console.log(`Detectados ${eventCount} eventos`);
    const tasks = [];

    // ── 4. ITERAR ───────────────────────────────────────────────────────────
    for (let i = 0; i < eventCount; i++) {
        console.log(`Procesando ${i + 1}/${eventCount}...`);
        try {
          // Re-localizar y clickear vía JS apuntando al contenido interno (según captura del usuario)
          const clicked = await page.evaluate((idx) => {
            const events = document.querySelectorAll('.fc-event, .fc-daygrid-event, .calendar-event');
            const ev = events[idx];
            if (ev) {
              ev.scrollIntoView({ block: 'center' });
              // Intentar clickear el interior o el icono si existen
              const inner = ev.querySelector('.fc-event-inner') || ev.querySelector('svg') || ev;
              inner.click();
              return true;
            }
            return false;
          }, i);
  
          if (!clicked) {
            console.warn(`  ⚠ No se pudo encontrar el evento ${i + 1} para clickear.`);
            continue;
          }

          // Esperar modal (más flexible)
          const modalVisible = await page.waitForSelector('[id*="pnlDetalleActividad"], .modal-content, .ui-dialog, [class*="modal"]', { 
            visible: true, 
            timeout: 10000 
          }).catch(async () => {
             // ERROR: El modal no apareció. Tomamos captura para ver qué pasó.
             try {
               const path = `/tmp/error_evento_${i+1}.png`;
               await page.screenshot({ path });
               console.log(`  📸 Captura de error guardada en: ${path} (El modal no abrió al clickear)`);
             } catch (e) {
               console.log("  (No se pudo tomar la captura de error)");
             }
             return null;
          });
  
          if (!modalVisible) {
            console.warn(`  ⚠ El modal de la tarea ${i + 1} no se detectó tras el clic.`);
            continue;
          }

          await waitForAjaxIdle(page, 3000);

          // ── EXTRACCIÓN (Resiliente) ─────────────────────────────────────────
          const detail = await page.evaluate(() => {
            const modal = document.querySelector('[id*="pnlDetalleActividad"]') || 
                          document.querySelector('.modal-content') || 
                          document.querySelector('.ui-dialog');
            if (!modal) return null;

            const fullText = (modal.innerText || "").trim().replace(/\s+/g, ' ');
            
            // Materia
            let category = "General";
            const header = modal.querySelector('.modal-header, .h-Title-S, h5');
            if (header && header.innerText.includes(' - ')) {
                category = header.innerText.split(' - ')[1].trim();
            } else if (modal.querySelector('.h-Title-S')) {
                category = modal.querySelector('.h-Title-S').innerText.trim();
            }

            // Título
            let title = "Tarea sin título";
            const tEl = modal.querySelector('.h-Title') || modal.querySelector('h3, h2');
            if (tEl && !tEl.innerText.toLowerCase().includes('detalle de')) {
                title = tEl.innerText.trim();
            }

            // Fecha
            let dueDate = null;
            const match = fullText.match(/(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})/);
            if (match) {
              const [_, dStr, tStr] = match;
              const [d, m, y] = dStr.split('/');
              dueDate = `${y}-${m}-${d} ${tStr}:00`;
            }

            return { title, category, dueDate };
          });

          if (detail && detail.dueDate) {
            console.log(`  ✓ Encontrada: ${detail.title} (${detail.dueDate})`);
            tasks.push(detail);
          } else {
            console.log(`  ✗ Datos incompletos para tarea ${i + 1}`);
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