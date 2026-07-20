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
  console.error("Error al cargar credenciales:", e);
}

// Crear servidor MCP
const server = new Server(
  { name: "mcp-sheets-farmacia", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Definir herramientas para Botmaker
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

// Lógica de búsqueda en tiempo real
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "consultar_producto") {
    const query = (request.params.arguments.busqueda || '').toLowerCase();
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

// Endpoint SSE mejorado para Handshake de MCP
let transport;

app.get("/sse", async (req, res) => {
  // Configurar headers para mantener la conexión SSE abierta
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  transport = new SSEServerTransport("/messages", res);
  await server.connect(transport);
});

app.post("/messages", express.json(), async (req, res) => {
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).send("Transport no iniciado");
  }
});

// Endpoint de prueba rápida para evitar que Render se duerma
app.get("/", (req, res) => res.send("Servidor MCP Farmacia Activo"));

app.listen(PORT, () => console.log(`Servidor MCP corriendo en puerto ${PORT}`));
