require('dotenv').config();
const express = require('express');
const path = require('path');
const http = require('http');
const { Server } = require("socket.io");
const admin = require("firebase-admin");
const cors = require('cors'); 

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

admin.initializeApp({
    credential: admin.credential.cert({
        projectId: process.env.PROJECT_ID,
        clientEmail: process.env.CLIENT_EMAIL,
        privateKey: process.env.PRIVATE_KEY ? process.env.PRIVATE_KEY.replace(/\\n/g, '\n') : undefined
    }),
    databaseURL: "https://superpote-e3dc4-default-rtdb.firebaseio.com/"
});

const db = admin.database();

// --- CRONÓMETRO MAESTRO ---
let contadorRondas = 0;

function cicloJuego() {
    contadorRondas++;
    db.ref('sistema/global/estadoJuego').set("apuestas");
    
    let tiempo = 30; 
    let contador = setInterval(async () => {
        io.emit('tiempo-actualizado', tiempo); 
        tiempo--;
        
        if (tiempo < 0) {
            clearInterval(contador);
            const esSuperpote = (contadorRondas % 20 === 0);
            await iniciarFaseGiro(esSuperpote);
        }
    }, 1000);
}

async function iniciarFaseGiro(esSuperpote) {
    db.ref('sistema/global/comandoGiro').update({ estado: "finalizado" });
    db.ref('sistema/global/estadoJuego').set("giro");

    let indiceGanador = await determinarGanadorSeguro(esSuperpote);
    
    db.ref('sistema/global/comandoGiro').set({ 
        estado: "girando", 
        indiceGanador: indiceGanador,
        tipo: esSuperpote ? "SUPERPOTE" : "NORMAL" 
    });

    setTimeout(() => {
        db.ref('sistema/global/estadoJuego').set("resultados");
        
        setTimeout(async () => {
            if (esSuperpote) {
                await db.ref('sistema/global/pote').set(0);
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

    if (esSuperpote) {
        return Math.floor(Math.random() * 30);
    }

    let opcionesSeguras = elementosSorteo.filter(figura => {
        const montoApuesta = apuestas[figura] || 0;
        return (montoApuesta * 30) <= poteActual;
    });

    return opcionesSeguras.length > 0 
        ? elementosSorteo.indexOf(opcionesSeguras[Math.floor(Math.random() * opcionesSeguras.length)]) 
        : 0;
}

// Iniciar ciclo
cicloJuego();

// --- RUTAS ---

app.post('/realizar-apuesta', async (req, res) => {
    const { userId, monto, figura } = req.body;
    const montoNum = Number(monto);
    const comision = montoNum * 0.20;
    const apuestaNeta = montoNum * 0.80;

    try {
        const refUser = db.ref(`sistema/usuarios/${userId}`);
        const snapshot = await refUser.once('value');
        const usuario = snapshot.val();

        if (!usuario || Number(usuario.saldo) < montoNum) {
            return res.status(400).json({ error: "Saldo insuficiente" });
        }

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

app.post('/deshacer-apuesta', async (req, res) => {
    const { userId } = req.body;
    const snapshot = await db.ref(`sistema/usuarios/${userId}/ultimaApuesta`).once('value');
    const apuesta = snapshot.val();

    if (!apuesta) return res.json({ success: false, message: "No hay apuestas." });

    await db.ref(`sistema/usuarios/${userId}/saldo`).transaction(s => (s || 0) + apuesta.monto);
    await db.ref(`sistema/apuestas_por_figura/${apuesta.figura}`).transaction(m => Math.max(0, m - apuesta.monto));
    await db.ref(`sistema/usuarios/${userId}/ultimaApuesta`).remove();

    res.json({ success: true });
});

io.on('connection', (socket) => {
    socket.on('usuario_conecta', (userId) => {
        if(userId) {
            db.ref(`sistema/online/${userId}`).set(true);
            socket.userId = userId;
        }
    });

    socket.on('disconnect', () => {
        if(socket.userId) {
            db.ref(`sistema/online/${socket.userId}`).remove();
        }
    });

    socket.on('admin_forzar_giro', (data) => {
        if (data.token === "R0b3rt0206#") { 
            db.ref('sistema/global/comandoGiro').set({ estado: "girando", indiceGanador: parseInt(data.indice) });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor activo en puerto ${PORT}`);
});