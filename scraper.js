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
          // Asegurarnos de que el calendario está despejado
          await cerrarModal(page);
          await new Promise(r => setTimeout(r, 1000));

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
            timeout: 10000 
          }).catch(async () => {
             // Re-intento si el primer clic falló (pasa a veces en ASP.NET)
             console.log(`  ↻ Re-intentando clic en evento ${i + 1}...`);
             await page.mouse.click(rect.x, rect.y);
             return await page.waitForSelector('.modal-content, .ui-dialog, [id*="pnlDetalleActividad"]', { 
               visible: true, 
               timeout: 5000 
             }).catch(() => null);
          });
  
          if (!modalVisible) {
            const path = `/tmp/error_click_evento_${i+1}.png`;
            await page.screenshot({ path });
            console.log(`  📸 Error: El modal no abrió. Foto en: ${path}`);
            continue;
          }

          // Espera a que el contenido AJAX se cargue realmente en el modal
          await new Promise(r => setTimeout(r, 2000));
          await waitForAjaxIdle(page, 4000);

          // ── EXTRACCIÓN (Pinpoint v11) ─────────────────────────────────────
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

            // 4. Fecha de entrega
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
            console.warn(`  ✗ Datos incompletos en tarea ${i + 1}.`);
          }

      } catch (err) {
        console.warn(`  Error en evento ${i + 1}:`, err.message);
      } finally {
        // Cierre y espera activa del postback que genera el botón
        await cerrarModal(page);
        await new Promise(r => setTimeout(r, 1000));
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
  // Intentar clic en botones de cerrar (genera Postback en ASP.NET)
  const closed = await page.evaluate(() => {
    const closeSelectors = [
      '[id*="lnkCerrar"]', '[id*="btnCerrar"]', '.modal-header .close',
      '.ui-dialog-titlebar-close', 'button.close'
    ];
    for (const sel of closeSelectors) {
      const btn = document.querySelector(sel);
      if (btn && btn.offsetParent !== null) {
        btn.click();
        return true;
      }
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return false;
  });

  if (closed) {
    await waitForAjaxIdle(page, 3000);
  }

  // Verificar si sigue algo bloqueando y limpiarlo suavemente
  await page.evaluate(() => {
    const blockers = document.querySelectorAll('.modal-backdrop, .ui-widget-overlay');
    blockers.forEach(el => { el.style.display = 'none'; });
  });
}

module.exports = { scrapeAcademicManager };