import express from "express";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

const app = express();
const PORT = process.env.PORT || 3000;

// Configuración de Google Sheets
let doc;
try {
  const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const serviceAccountAuth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, serviceAccountAuth);
} catch (e) {
  console.error("Error al cargar credenciales de Google Sheets:", e);
}

// Inicialización del Servidor MCP
const server = new Server(
  { name: "mcp-sheets-farmacia", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Declaración de Herramientas (Tools)
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{
    name: "consultar_producto",
    description: "Busca productos en la farmacia por nombre, descripción, SKU o código de barras en tiempo real.",
    inputSchema: {
      type: "object",
      properties: {
        busqueda: { type: "string", description: "Nombre, SKU o código de barras del producto" }
      },
      required: ["busqueda"]
    }
  }]
}));

// Ejecución de la Herramienta
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "consultar_producto") {
    const query = (request.params.arguments?.busqueda || '').toLowerCase();
    
    if (!doc) {
      return { content: [{ type: "text", text: "Error: No hay conexión con la base de datos." }] };
    }

    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();

    const resultados = rows.filter(row => {
      const descrip = (row.get('descrip') || '').toLowerCase();
      const sku = (row.get('sku') || '').toString().toLowerCase();
      const barras = (row.get('barras') || '').toString().toLowerCase();
      return descrip.includes(query) || sku.includes(query) || barras.includes(query);
    }).map(row => ({
      sku: row.get('sku'),
      barras: row.get('barras'),
      descripcion: row.get('descrip'),
      precio: row.get('precio'),
      stock: row.get('stock')
    }));

    return {
      content: [{ type: "text", text: JSON.stringify(resultados.slice(0, 5)) }]
    };
  }
});

// Almacenamiento de sesiones SSE activas
const transports = new Map();

// Endpoint SSE principal para Botmaker
app.get("/sse", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Content-Type", "text/event-stream");

  const transport = new SSEServerTransport("/messages", res);
  const sessionId = transport.sessionId;
  transports.set(sessionId, transport);

  req.on("close", () => {
    transports.delete(sessionId);
  });

  await server.connect(transport);
});

// Endpoint POST para mensajes vinculados a la sesión
app.post("/messages", express.json(), async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  
  const sessionId = req.query.sessionId;
  let transport = transports.get(sessionId);

  // Fallback de respaldo por si no viene el ID en la Query
  if (!transport && transports.size > 0) {
    transport = Array.from(transports.values())[transports.size - 1];
  }

  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).send("Sesión no encontrada");
  }
});

// Endpoint de prueba rápida
app.get("/", (req, res) => res.send("OK"));

app.listen(PORT, () => console.log(`Servidor activo en puerto ${PORT}`));
