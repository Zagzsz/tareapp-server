const puppeteer = require('puppeteer');

/**
 * Scraper para extraer tareas de Academic Manager (ueh.academic.lat)
 * @param {string} username - Usuario de la plataforma
 * @param {string} password - Contraseña
 * @returns {Promise<Array>} - Lista de tareas encontradas
 */
async function scrapeAcademicManager(username, password) {
  let browser;
  try {
    // Configuración para Render (usa el ejecutable de Chrome si está disponible)
    browser = await puppeteer.launch({
      headless: "new",
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    
    // 1. Ir al Login
    console.log('Navegando a login...');
    // Aumentar el timeout por defecto y usar domcontentloaded que es más rápido
    await page.setDefaultNavigationTimeout(60000); 
    await page.goto('https://ueh.academic.lat/Autenticacion.aspx', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // 2. Llenar Credenciales (IDs verificados por el subagente)
    console.log('Ingresando credenciales...');
    await page.waitForSelector('#txtUsuario', { timeout: 30000 });
    await page.type('#txtUsuario', username);
    await page.type('#txtContrasenia', password);
    
    // El botón de entrar es un enlace que hace postback
    console.log('Haciendo clic en Entrar...');
    await Promise.all([
      page.click('#lnkEntrar'),
      page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 60000 }).catch(() => console.log("Aviso: Navegación lenta tras login."))
    ]);

    // Verificar si seguimos en Login (Login fallido)
    const isStillOnLogin = await page.$('#txtUsuario');
    if (isStillOnLogin) {
      console.error('Error: Las credenciales parecen ser incorrectas o hubo un error en el portal.');
      throw new Error('Login fallido en Academic Manager');
    }

    // 3. Navegar a Actividades
    console.log('Navegando a actividades...');
    await page.goto('https://ueh.academic.lat/Alumno/AlumnoActividadesClase.aspx', { waitUntil: 'networkidle0', timeout: 60000 });
    
    // Esperar explícitamente a que el calendario cargue (FullCalendar)
    console.log('Esperando el calendario...');
    await page.waitForSelector('.fc-view-container, #calendar', { timeout: 30000 });

    // 4. Extraer eventos del Calendario
    console.log('Detectando eventos en el calendario...');
    
    // Obtenemos la cantidad de eventos primero
    const eventCount = await page.evaluate(() => {
      return document.querySelectorAll('.fc-event, .fc-daygrid-event, .calendar-event').length;
    });

    const tasks = [];
    console.log(`Procesando ${eventCount} eventos detalladamente...`);

    for (let i = 0; i < eventCount; i++) {
      try {
        console.log(`Procesando tarea ${i + 1}/${eventCount}...`);
        
        // RE-BUSCAR el elemento por índice en cada iteración para evitar "Protocol Error"
        await page.evaluate((idx) => {
          const events = document.querySelectorAll('.fc-event, .fc-daygrid-event, .calendar-event');
          if (events[idx]) {
            events[idx].scrollIntoView();
            events[idx].click();
          }
        }, i);
        
        // Esperar el modal específico
        await page.waitForSelector('[id*="pnlDetalleActividad"], [id*="DetalleActividad"], .modal-content', { timeout: 10000 });
        await new Promise(r => setTimeout(r, 1200)); // Un poco más de tiempo para carga de datos AJAX

        const detail = await page.evaluate(() => {
          const modal = document.querySelector('[id*="pnlDetalleActividad"]') || 
                        document.querySelector('[id*="DetalleActividad"]') || 
                        document.querySelector('.modal-content');
          if (!modal) return { error: "Modal no encontrado" };

          const fullText = (modal.innerText || "").trim().replace(/\s+/g, ' ');
          
          // Debug: Retornamos los primeros 200 caracteres para ver qué lee el bot en los logs de Render
          const debugSnippet = fullText.substring(0, 200);

          // 1. Materia/Asignatura
          let category = "General";
          const asignaturaEl = modal.querySelector('.h-Title-S') || 
                               modal.querySelector('h5') || 
                               modal.querySelector('[class*="Asignatura"]');
          if (asignaturaEl) category = asignaturaEl.innerText.trim();

          // 2. Título (Evitar el genérico)
          let title = "Tarea sin título";
          const titleEl = modal.querySelector('.h-Title') || 
                          modal.querySelector('h2, h3, .titulo');
          
          if (titleEl && !titleEl.innerText.includes("Detalle de Actividad")) {
            title = titleEl.innerText.trim();
          } else {
            const h3s = Array.from(modal.querySelectorAll('h3, h2, .h-Title'));
            const realTitle = h3s.find(el => !el.innerText.includes("Detalle de"));
            if (realTitle) title = realTitle.innerText.trim();
          }

          // 3. Fecha de entrega (Ultra-resiliente)
          let dueDate = null;
          // Buscar primero por el selector que vimos (.dv-right-section)
          const dateEl = modal.querySelector('[id*="lblFechaEntrega"]') || 
                         modal.querySelector('[id*="lblFechaFin"]') ||
                         modal.querySelector('.dv-right-section');
          
          const textToSearch = dateEl ? dateEl.innerText + " " + fullText : fullText;
          
          // Regex mejorada: DD/MM/YYYY seguido de HH:mm (permite espacios extras)
          const match = textToSearch.match(/(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})/);
          if (match) {
            const [_, date, time] = match;
            const [d, m, y] = date.split('/');
            dueDate = `${y}-${m}-${d} ${time}:00`;
          }

          return { title, category, dueDate, debugSnippet };
        });

        if (detail && detail.dueDate) {
          console.log(`- [OK] Tarea ${i + 1}: ${detail.title} | Fecha: ${detail.dueDate}`);
          tasks.push({
            title: detail.title,
            category: detail.category,
            dueDate: detail.dueDate,
            description: `Sincronizado de Academic Manager\nExtracto: ${detail.debugSnippet}...`
          });
        } else {
          console.log(`- [ERROR] Tarea ${i + 1}: No se detectó fecha. Texto visto: "${detail ? detail.debugSnippet : 'N/A'}"`);
        }

        // Cerrar el modal mediante JS directo al botón de cierre
        await page.evaluate(() => {
          const closeBtn = document.querySelector('[id*="lnkCerrarDetalleActividad"]') || 
                           document.querySelector('.close') || 
                           document.querySelector('[id*="lnkCerrar"]');
          if (closeBtn) closeBtn.click();
          else window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        });
        
        // Esperar a que el modal desaparezca totalmente
        await page.waitForFunction(() => {
          const modal = document.querySelector('[id*="pnlDetalleActividad"], .modal-backdrop, .modal-content');
          return !modal || modal.offsetParent === null;
        }, { timeout: 5000 }).catch(() => {});
        
        await new Promise(r => setTimeout(r, 1000));

      } catch (err) {
        console.warn(`Error en tarea índice ${i}:`, err.message);
        await page.keyboard.press('Escape').catch(() => {});
        await new Promise(r => setTimeout(r, 1500));
      }
    }

    console.log(`Sincronización terminada. ${tasks.length} tareas válidas procesadas.`);
    return tasks;

  } catch (error) {
    console.error('Error en el scraping:', error);
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { scrapeAcademicManager };
