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
    
    // Obtenemos los handles de todos los eventos visibles
    const eventHandles = await page.$$('.fc-event, .fc-daygrid-event, .calendar-event');
    const tasks = [];
    console.log(`Procesando ${eventHandles.length} eventos detalladamente...`);

    for (let i = 0; i < eventHandles.length; i++) {
      try {
        const handle = eventHandles[i];
        
        // Asegurarse de que sea visible y clickearlo via JS para evitar bloqueos
        await page.evaluate((el) => {
          el.scrollIntoView();
          el.click(); // Click nativo de JS
        }, handle);
        
        // Esperar el modal específico
        await page.waitForSelector('[id*="pnlDetalleActividad"], [id*="DetalleActividad"], .modal-content', { timeout: 8000 });
        await new Promise(r => setTimeout(r, 1000)); // Esperar carga de datos

        const detail = await page.evaluate(() => {
          const modal = document.querySelector('[id*="pnlDetalleActividad"]') || 
                        document.querySelector('[id*="DetalleActividad"]') || 
                        document.querySelector('.modal-content');
          if (!modal) return null;

          const fullText = modal.innerText || "";
          
          // Asignatura
          let category = "General";
          const asignaturaEl = modal.querySelector('h5') || modal.querySelector('[class*="Asignatura"]');
          if (asignaturaEl) category = asignaturaEl.innerText.trim();

          // Título
          let title = "Tarea sin título";
          const titleEl = modal.querySelector('h2, h3, .titulo');
          if (titleEl) title = titleEl.innerText.trim();

          // Fecha de entrega
          const dateRegex = /(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})/;
          const match = fullText.match(dateRegex);
          let dueDate = null;
          if (match) {
            const [_, date, time] = match;
            const [d, m, y] = date.split('/');
            dueDate = `${y}-${m}-${d} ${time}:00`;
          }

          return { title, category, dueDate, description: `Sincronizado de Academic Manager\n${fullText.substring(0, 300)}` };
        });

        if (detail) tasks.push(detail);

        // Cerrar el modal
        await page.evaluate(() => {
          const closeBtn = document.querySelector('[id*="lnkCerrarDetalleActividad"], .close, [class*="cerrar"]');
          if (closeBtn) closeBtn.click();
          else window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
        });
        
        // Esperar a que limpie el DOM
        await new Promise(r => setTimeout(r, 800));

      } catch (err) {
        console.warn(`Error en tarea índice ${i}:`, err.message);
        await page.keyboard.press('Escape').catch(() => {});
      }
    }

    console.log(`Sincronización terminada. ${tasks.length} tareas procesadas con éxito.`);
    return tasks;

  } catch (error) {
    console.error('Error en el scraping:', error);
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { scrapeAcademicManager };
