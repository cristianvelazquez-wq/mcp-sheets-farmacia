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
  console.error("Error cargando credenciales:", e);
}

// Crear servidor MCP
const server = new Server(
  { name: "mcp-sheets-farmacia", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Registrar Herramientas para Botmaker
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

// Registrar la ejecución de la consulta
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === "consultar_producto") {
    const query = (request.params.arguments?.busqueda || '').toLowerCase();
    
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

// Manejo de conexiones SSE (Requerido por Botmaker)
const transports = new Map();

app.get("/sse", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const transport = new SSEServerTransport("/messages", res);
  
  const sessionId = Math.random().toString(36).substring(2);
  transports.set(sessionId, transport);

  req.on("close", () => {
    transports.delete(sessionId);
  });

  await server.connect(transport);
});

app.post("/messages", express.json(), async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  // Tomar el transporte activo
  const transport = Array.from(transports.values())[0];
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).send("No hay conexión SSE activa");
  }
});

app.listen(PORT, () => console.log(`Servidor MCP activo en puerto ${PORT}`));
