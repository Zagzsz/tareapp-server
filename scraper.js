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
          // ASEGURARNOS DE QUE NO HAY MODALES PREVIOS BLOQUEANDO (Cruce de seguridad)
          await cerrarModal(page);

          // Obtener las coordenadas del centro del evento
          const rect = await page.evaluate((idx) => {
            const events = document.querySelectorAll('.fc-event, .fc-daygrid-event, .calendar-event');
            const ev = events[idx];
            if (ev) {
              ev.scrollIntoView({ block: 'center', behavior: 'instant' });
              const r = ev.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }
            return null;
          }, i);

          if (!rect) {
            console.warn(`  ⚠ No se pudo obtener coordenadas para evento ${i + 1}`);
            continue;
          }

          // Clic real de ratón (Simula humano)
          await page.mouse.click(rect.x, rect.y);
  
          // Esperar a que el modal aparezca
          const modalVisible = await page.waitForSelector('.modal-content, .ui-dialog, [id*="pnlDetalleActividad"]', { 
            visible: true, 
            timeout: 12000 
          }).catch(async () => {
             const path = `/tmp/error_click_evento_${i+1}.png`;
             await page.screenshot({ path });
             console.log(`  📸 Error: El modal no abrió. Foto en: ${path}`);
             return null;
          });
  
          if (!modalVisible) continue;

          // Espera a que el contenido AJAX se cargue realmente en el modal
          await new Promise(r => setTimeout(r, 3000));
          await waitForAjaxIdle(page, 4000);

          // ── EXTRACCIÓN (Pinpoint v10) ─────────────────────────────────────
          const detail = await page.evaluate(() => {
            const modal = document.querySelector('[id*="pnlDetalleActividad"]') || 
                          document.querySelector('.modal-content') || 
                          document.querySelector('.ui-dialog');
            if (!modal) return null;

            const fullText = (modal.innerText || "").trim().replace(/\s+/g, ' ');
            
            // 1. Materia
            let category = "General";
            const asigEl = modal.querySelector('.hAsignatura') || modal.querySelector('h5');
            if (asigEl) category = asigEl.innerText.trim();

            // 2. Título
            let title = "Tarea sin título";
            const actEl = modal.querySelector('.hActividad') || modal.querySelector('h2');
            if (actEl) title = actEl.innerText.replace(/"/g, '').trim();

            // 3. Descripción
            let description = "Sincronizado de Academic Manager";
            const descEl = modal.querySelector('.descripActividad') || modal.querySelector('p');
            if (descEl) description = descEl.innerText.trim();

            // 4. Fecha de entrega (Regex sobre el texto del modal)
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
            console.log(`  ✓ OK: ${detail.title} - ${detail.dueDate}`);
            tasks.push(detail);
          } else {
            console.warn(`  ✗ Datos incompletos en tarea ${i + 1}. No se agregará.`);
          }

      } catch (err) {
        console.warn(`  Error en evento ${i + 1}:`, err.message);
      } finally {
        // Cierre AGRESIVO del modal para la siguiente iteración
        await cerrarModal(page);
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    console.log(`\n✅ ${tasks.length}/${eventCount} tareas válidas extraídas`);
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
    // 1. Intentar clic en botones de cerrar conocidos
    const closeSelectors = [
      '[id*="lnkCerrar"]', '[id*="btnCerrar"]', '.modal-header .close',
      '.ui-dialog-titlebar-close', 'button.close', '.close', '.ui-icon-closethick'
    ];
    closeSelectors.forEach(sel => {
      const btn = document.querySelector(sel);
      if (btn && btn.offsetParent !== null) btn.click();
    });

    // 2. Forzar cierre con Escape
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    // 3. AGRESIVO: Eliminar cualquier modal o backdrop que bloquee el calendario
    const blockers = document.querySelectorAll('.modal, .modal-backdrop, .ui-dialog, .ui-widget-overlay, [id*="pnlDetalleActividad"]');
    blockers.forEach(el => {
        if (el) {
            el.style.display = 'none';
            el.style.pointerEvents = 'none';
            el.classList.remove('show', 'in');
        }
    });
    
    // Limpiar clases del body que bloquean el scroll
    document.body.classList.remove('modal-open');
    document.body.style.overflow = 'auto';
  });

  // Esperar un momento a que el DOM se asiente
  await new Promise(r => setTimeout(r, 1000));
}

module.exports = { scrapeAcademicManager };