require('dotenv').config();
const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
const admin = require("firebase-admin");

// --- ESTO ES CRÍTICO: DEBE IR AQUÍ ---
app.use(express.json()); 
app.use(express.static('public')); // O la carpeta donde está tu index.html
// -------------------------------------

admin.initializeApp({
    credential: admin.credential.cert({
        projectId: process.env.PROJECT_ID,
        clientEmail: process.env.CLIENT_EMAIL,
        privateKey: process.env.PRIVATE_KEY.replace(/\\n/g, '\n')
    }),
    databaseURL: "https://superpote-e3dc4-default-rtdb.firebaseio.com/"
});

const db = admin.database();
console.log("URL de Base de Datos:", db.ref().toString());

// --- NUEVO CRONÓMETRO MAESTRO (60 SEGUNDOS TOTALES) ---
let contadorRondas = 0;

function cicloJuego() {
    contadorRondas++;
    db.ref('sistema/global/estadoJuego').set("apuestas");
    
    let tiempo = 30; // 30s de apuestas
    let contador = setInterval(async () => {
        io.emit('tiempo-actualizado', tiempo); 
        tiempo--;
        
        if (tiempo < 0) {
            clearInterval(contador);
            // El Superpote ocurre cada 20 rondas
            const esSuperpote = (contadorRondas % 20 === 0);
            await iniciarFaseGiro(esSuperpote);
        }
    }, 1000);
}

async function iniciarFaseGiro(esSuperpote) {
    db.ref('sistema/global/comandoGiro').update({ estado: "finalizado" });
    db.ref('sistema/global/estadoJuego').set("giro");

    // AQUÍ USAMOS TU "CEREBRO" DE SEGURIDAD
    // Si es superpote, podríamos relajar la seguridad, pero mantengámosla por ahora
    let indiceGanador = await determinarGanadorSeguro(esSuperpote);
    
    db.ref('sistema/global/comandoGiro').set({ 
        estado: "girando", 
        indiceGanador: indiceGanador,
        tipo: esSuperpote ? "SUPERPOTE" : "NORMAL" 
    });

    // 5s giro + 5s mostrar resultado + 20s descanso = 30s adicionales (Total 60s)
    setTimeout(() => {
        db.ref('sistema/global/estadoJuego').set("resultados");
        
        // Dentro de iniciarFaseGiro, al finalizar la ronda:
setTimeout(async () => {
    if (esSuperpote) {
        await db.ref('sistema/global/pote').set(0); // Vacía el pote tras entregar el premio
        console.log("¡SUPERPOTE ENTREGADO! Pote reiniciado.");
    }
    await db.ref('sistema/apuestas_por_figura').set(null);
    cicloJuego();
}, 25000);
    }, 5000);
}

async function determinarGanadorSeguro(esSuperpote) {
    const snapPote = await db.ref('sistema/global/pote').once('value');
    const poteActual = snapPote.val() || 0;
    const snapApuestas = await db.ref('sistema/apuestas_por_figura').once('value');
    const apuestas = snapApuestas.val() || {};

    const elementosSorteo = [
        "Limón", "Coco", "Manzana", "Pera", "Cereza", "Durazno", "Kiwi", "Ciruela", "Mora", "Aguacate",
        "Perro", "Gato", "León", "Tigre", "Mono", "Oso", "Zorro", "Lobo", "Águila", "Loro",
        "Delfín", "Culebra", "Sapo", "Pez", "Toro", "Vaca", "Caballo", "Oveja", "Gallo", "Fresa"
    ];

    // LÓGICA DE SUPERPOTE: Si es Superpote, permitimos cualquier ganador
    if (esSuperpote) {
        // Elegimos al azar cualquier figura sin restricciones
        return Math.floor(Math.random() * 30);
    }

    // LÓGICA NORMAL: Filtramos para proteger el pote
    let opcionesSeguras = elementosSorteo.filter(figura => {
        const montoApuesta = apuestas[figura] || 0;
        return (montoApuesta * 30) <= poteActual;
    });

    if (opcionesSeguras.length > 0) {
        let figuraGanadora = opcionesSeguras[Math.floor(Math.random() * opcionesSeguras.length)];
        return elementosSorteo.indexOf(figuraGanadora);
    } else {
        return 0; // Protección contra quiebra
    }
}

async function finalizarRondaYLimpiar() {
    // 1. Borrar apuestas de figuras
    await db.ref('sistema/apuestas_por_figura').set(null);
    // 2. Opcional: Si quieres reiniciar el pote (cuidado con esto)
    // await db.ref('sistema/global/pote').set(0); 
    console.log("Historial limpiado correctamente.");
}

cicloJuego();

const cors = require('cors');
app.use(cors());

// Rutas y Socket

app.post('/realizar-apuesta', async (req, res) => {
    const { userId, monto, figura } = req.body; // <--- Debes extraer esto primero
    const montoNum = Number(monto);
    
    // Cálculos correctos
    const comision = montoNum * 0.20;
    const apuestaNeta = montoNum * 0.80;

    try {
        const refUser = db.ref(`sistema/usuarios/${userId}`);
        const snapshot = await refUser.once('value');
        const usuario = snapshot.val();

        if (!usuario || Number(usuario.saldo) < montoNum) {
            return res.status(400).json({ error: "Saldo insuficiente o usuario no existe" });
        }

        // Operaciones atómicas
        await refUser.update({ saldo: Number(usuario.saldo) - montoNum });
        await db.ref('sistema/global/bovedaCasa').transaction(b => (b || 0) + comision);
        await db.ref('sistema/global/pote').transaction(p => (p || 0) + apuestaNeta);
        await db.ref(`sistema/apuestas_por_figura/${figura}`).transaction(m => (m || 0) + montoNum);
        await db.ref(`sistema/usuarios/${userId}/ultimaApuesta`).set({ figura, monto, timestamp: Date.now() });
        return res.status(200).json({ success: true });
    } catch (error) {
        return res.status(500).json({ error: "Error interno" });
    }
});

app.post('/solicitar-deposito', (req, res) => {
    const { userId, monto, referencia } = req.body;
    const nuevaSol = db.ref('sistema/solicitudes/depositos').push({
        userId, monto, referencia,
        estado: 'pendiente',
        timestamp: Date.now()
    });
    
  
    io.emit('nueva_solicitud_admin', { id: nuevaSol.key, userId, monto });
    
    res.json({ success: true });
});

io.on('connection', (socket) => {
    // 1. Conexión de usuario
    socket.on('usuario_conecta', (userId) => {
        if(userId) {
            db.ref(`sistema/online/${userId}`).set(true);
            socket.userId = userId;
        }
    });

    // 2. Desconexión
    socket.on('disconnect', () => {
        if(socket.userId) {
            db.ref(`sistema/online/${socket.userId}`).remove();
        }
    });

    // 3. Comando del Admin
    // En tu socket.on('admin_forzar_giro')
socket.on('admin_forzar_giro', (data) => {
    if (data.token === "R0b3rt0206#") { 
        db.ref('sistema/global/comandoGiro').set({ estado: "girando", indiceGanador: parseInt(data.indice) });
    }
});
// --- PASO 2: LÓGICA DE DESHACER EN EL SERVIDOR ---
// En server.js, actualiza la ruta /deshacer-apuesta
app.post('/deshacer-apuesta', async (req, res) => {
    const { userId } = req.body;
    
    // 1. Buscamos en Firebase la última apuesta de este usuario
    const snapshot = await db.ref(`sistema/usuarios/${userId}/ultimaApuesta`).once('value');
    const apuesta = snapshot.val();

    if (!apuesta) {
        return res.json({ success: false, message: "No hay apuestas recientes." });
    }

    // 2. Realizamos la reversión matemática en el servidor (seguro)
    const monto = apuesta.monto;
    const figura = apuesta.figura;

    await db.ref(`sistema/usuarios/${userId}/saldo`).transaction(s => (s || 0) + monto);
    await db.ref(`sistema/apuestas_por_figura/${figura}`).transaction(m => Math.max(0, m - monto));
    
    // 3. Borramos el registro para que no se pueda deshacer dos veces
    await db.ref(`sistema/usuarios/${userId}/ultimaApuesta`).remove();

    res.json({ success: true });
});


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));