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

    // Permitir CSS para que el calendario tenga dimensiones reales
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const type = req.resourceType();
      if (['image', 'font', 'media'].includes(type)) {
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

    // ── 2. CALENDARIO ───────────────────────────────────────────────────────
    console.log('Navegando a actividades...');
    await page.goto('https://ueh.academic.lat/Alumno/AlumnoActividadesClase.aspx', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    await page.waitForSelector('.fc-event, .fc-daygrid-event, .calendar-event', { timeout: 30000 });
    await new Promise(r => setTimeout(r, 4000));

    // ── 3. CONTAR EVENTOS ───────────────────────────────────────────────────
    const eventCount = await page.evaluate(() =>
      document.querySelectorAll('.fc-event, .fc-daygrid-event, .calendar-event').length
    );

    console.log(`Detectados ${eventCount} eventos`);
    const tasks = [];
    let lastTitle = "";

    // ── 4. ITERAR ───────────────────────────────────────────────────────────
    for (let i = 0; i < eventCount; i++) {
        console.log(`Procesando ${i + 1}/${eventCount}...`);
        try {
          // ASEGURAR ESTADO LIMPIO
          await cerrarModal(page);
          await new Promise(r => setTimeout(r, 1500));

          // Obtener coordenadas del evento
          const rect = await page.evaluate((idx) => {
            const ev = document.querySelectorAll('.fc-event, .fc-daygrid-event, .calendar-event')[idx];
            if (ev) {
              ev.scrollIntoView({ block: 'center', behavior: 'instant' });
              const r = ev.getBoundingClientRect();
              return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
            }
            return null;
          }, i);

          if (!rect) continue;

          // Clic real de ratón
          await page.mouse.click(rect.x, rect.y);
  
          // Esperar modal
          const modalSelector = '.modal-content, .ui-dialog, [id*="pnlDetalleActividad"]';
          const modalVisible = await page.waitForSelector(modalSelector, { visible: true, timeout: 8000 })
            .catch(async () => {
              console.log(`  ↻ Re-intento de clic en evento ${i + 1}...`);
              await page.mouse.click(rect.x, rect.y);
              return await page.waitForSelector(modalSelector, { visible: true, timeout: 5000 }).catch(() => null);
            });
  
          if (!modalVisible) {
            console.log(`  ✗ Tarea ${i + 1} no abrió. Saltando.`);
            continue;
          }

          // Carga AJAX
          await new Promise(r => setTimeout(r, 2000));
          await waitForAjaxIdle(page, 4000);

          // ── EXTRACCIÓN (Pinpoint v12) ─────────────────────────────────────
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

          // VERIFICACIÓN DE DUPLICADOS (Evitar Actividad 3 repetida)
          if (detail && detail.dueDate) {
            if (detail.title === lastTitle && i > 0) {
              console.warn(`  ⚠ Tarea duplicada detectada ("${detail.title}"). El modal no se refrescó.`);
              // Intentamos cerrar y re-clickear en la siguiente vuelta si es necesario
            } else {
              console.log(`  ✓ OK: ${detail.title} - ${detail.dueDate}`);
              tasks.push(detail);
              lastTitle = detail.title;
            }
          }

      } catch (err) {
        console.warn(`  Error en evento ${i + 1}:`, err.message);
      } finally {
        await cerrarModal(page);
      }
    }

    console.log(`\n✅ Terminado: ${tasks.length} tareas únicas extraídas`);
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

async function cerrarModal(page) {
  try {
    // 1. Obtener coordenadas del botón de cerrar y hacer clic real
    const closeBtnRect = await page.evaluate(() => {
      const sels = ['[id*="lnkCerrar"]', '[id*="btnCerrar"]', '.ui-dialog-titlebar-close', 'button.close', '.modal-header .close'];
      for (const sel of sels) {
        const btn = document.querySelector(sel);
        if (btn && btn.offsetParent !== null) {
          const r = btn.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
      }
      return null;
    });

    if (closeBtnRect) {
      await page.mouse.click(closeBtnRect.x, closeBtnRect.y);
      await waitForAjaxIdle(page, 3000);
    } else {
      await page.keyboard.press('Escape');
    }

    // 2. ESPERAR A QUE EL MODAL DESAPAREZCA DEL DOM VISIBLE
    await page.waitForFunction(() => {
      const modal = document.querySelector('.modal-content, .ui-dialog, [id*="pnlDetalleActividad"]');
      return !modal || modal.offsetParent === null;
    }, { timeout: 3000 }).catch(() => {});

    // 3. LIMPIEZA HAMMER (Si persiste, eliminarlo para el siguiente clic)
    await page.evaluate(() => {
      const blockers = document.querySelectorAll('.modal, .modal-backdrop, .ui-dialog, .ui-widget-overlay, [id*="pnlDetalleActividad"]');
      blockers.forEach(el => {
        el.style.display = 'none';
        el.style.pointerEvents = 'none';
        el.remove(); // Físicamente fuera del DOM
      });
      document.body.classList.remove('modal-open');
      document.body.style.overflow = 'auto';
    });
    
    await new Promise(r => setTimeout(r, 800));
  } catch (e) {
    console.log("Aviso en cerrarModal:", e.message);
  }
}

module.exports = { scrapeAcademicManager };