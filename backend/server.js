// backend/server.js
require("dotenv").config();
const express = require("express");
const multer = require("multer");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const { exec } = require("child_process");
const util = require("util");
const execAsync = util.promisify(exec);

const app = express();

// CORS configuration
const corsOptions = {
  origin: ["*"],
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
  credentials: true,
  optionsSuccessStatus: 204,
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "Accept",
    "Origin",
  ],
  exposedHeaders: ["Content-Range", "X-Content-Range"],
};

// Apply CORS middleware before other routes
app.use(cors(corsOptions));

// Parse JSON request bodies
app.use(express.json());

// Add OPTIONS handling for preflight requests
app.options("*", cors(corsOptions));

const PORT = process.env.PORT || 3500;

// Port validation function
const isPortSafe = (port) => {
  const portNum = parseInt(port);
  // Check if port is in the allowed range (9001-9999)
  return portNum >= 9001 && portNum <= 9999;
};

// Check if port is in use
const isPortInUse = async (port) => {
  try {
    const { stdout, stderr } = await execAsync(
      `netstat -tln | grep ":${port}"`
    );
    return stdout.length > 0;
  } catch (error) {
    // If command fails, port is likely not in use
    return false;
  }
};

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, process.env.UPLOAD_DIR || "uploads");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    // Keep original filename but ensure it's safe
    const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
    cb(null, safeName);
  },
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    // Only accept JSON files
    if (
      file.mimetype !== "application/json" &&
      !file.originalname.endsWith(".json")
    ) {
      return cb(new Error("Only JSON files are allowed"));
    }
    cb(null, true);
  },
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB limit
  },
});

// Store running Mockoon instances
const mockInstances = new Map();

// Middleware
app.use(express.json());
app.use(cors());

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "healthy" });
});

// Start mock server endpoint
app.post("/api/mock/start", async (req, res) => {
  const { port, configFile } = req.body;

  try {
    // Validate port if provided
    if (port && !isPortSafe(port)) {
      return res.status(400).json({
        error: "Invalid port. Port must be between 9001 and 9999.",
      });
    }

    // Check if port is in use
    const portInUse = await isPortInUse(port);
    if (portInUse) {
      return res.status(400).json({
        error: `Port ${port} is already in use.`,
      });
    }

    const configPath = path.join(
      __dirname,
      process.env.CONFIGS_DIR || "configs",
      configFile
    );

    if (!fs.existsSync(configPath)) {
      return res.status(404).json({ error: "Configuration file not found" });
    }

    const mockProcess = spawn("mockoon-cli", [
      "start",
      "--data",
      configPath,
      "--port",
      port,
    ]);

    // Set up logging
    const logFile = fs.createWriteStream(
      path.join(__dirname, "logs", `mock-${port}.log`),
      { flags: "a" }
    );

    mockProcess.stdout.pipe(logFile);
    mockProcess.stderr.pipe(logFile);

    mockInstances.set(port, {
      process: mockProcess,
      configFile,
      startTime: new Date(),
      logFile,
    });

    res.json({
      success: true,
      port,
      configFile,
      message: `Mock server started on port ${port}`,
    });
  } catch (error) {
    console.error("Error starting mock server:", error);
    res.status(500).json({ error: error.message });
  }
});

// Stop mock server
app.post("/api/mock/stop", (req, res) => {
  const { port } = req.body;

  if (!mockInstances.has(port)) {
    return res.status(404).json({ error: "Instance not found" });
  }

  try {
    const instance = mockInstances.get(port);
    instance.process.kill();
    instance.logFile.end();
    mockInstances.delete(port);

    res.json({
      success: true,
      port,
      message: `Mock server on port ${port} stopped`,
    });
  } catch (error) {
    console.error("Error stopping mock server:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get status of all instances
app.get("/api/mock/status", (req, res) => {
  try {
    const status = Array.from(mockInstances.entries()).map(
      ([port, instance]) => ({
        port: parseInt(port),
        configFile: instance.configFile,
        uptime: Date.now() - instance.startTime,
        uptimeFormatted: formatUptime(Date.now() - instance.startTime),
      })
    );

    res.json(status);
  } catch (error) {
    console.error("Error getting status:", error);
    res.status(500).json({ error: error.message });
  }
});

// Upload configuration file
app.post("/api/mock/upload", upload.single("config"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const configsDir = path.join(
      __dirname,
      process.env.CONFIGS_DIR || "configs"
    );

    // Check if file already exists
    const existingFiles = fs.readdirSync(configsDir);
    if (existingFiles.includes(req.file.filename)) {
      // Delete the temporarily uploaded file
      fs.unlinkSync(req.file.path);
      return res.status(409).json({ 
        error: "A configuration with this name already exists. Please upload with a different filename." 
      });
    }

    if (!fs.existsSync(configsDir)) {
      fs.mkdirSync(configsDir, { recursive: true });
    }

    const newPath = path.join(configsDir, req.file.filename);
    fs.renameSync(req.file.path, newPath);

    res.json({
      success: true,
      filename: req.file.filename,
      message: "Configuration file uploaded successfully",
    });
  } catch (error) {
    // Clean up any uploaded file if it exists
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    console.error("Error uploading file:", error);
    res.status(500).json({ error: error.message });
  }
});

// Get list of available configurations
app.get("/api/mock/configs", async (req, res) => {
  try {
    const configsDir = path.join(__dirname, "configs");
    if (!fs.existsSync(configsDir)) {
      fs.mkdirSync(configsDir, { recursive: true });
    }

    const files = fs
      .readdirSync(configsDir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => {
        const stats = fs.statSync(path.join(configsDir, file));
        return {
          name: file,
          size: formatFileSize(stats.size),
          modified: stats.mtime,
          inUse: Array.from(mockInstances.values()).some(
            (instance) => instance.configFile === file
          ),
        };
      });

    res.json(files);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete config file
app.delete("/api/mock/configs/:filename", async (req, res) => {
  try {
    const { filename } = req.params;
    const configPath = path.join(__dirname, "configs", filename);

    // Check if file exists
    if (!fs.existsSync(configPath)) {
      return res.status(404).json({ error: "Configuration file not found" });
    }

    // Check if config is in use
    const isConfigInUse = Array.from(mockInstances.values()).some(
      (instance) => instance.configFile === filename
    );

    if (isConfigInUse) {
      return res.status(400).json({
        error: "Configuration is currently in use by a running mock server",
      });
    }

    // Delete the file
    fs.unlinkSync(configPath);
    res.json({
      success: true,
      message: `Configuration ${filename} deleted successfully`,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Download config file
app.get("/api/mock/configs/:filename/download", async (req, res) => {
  try {
    const { filename } = req.params;
    const configPath = path.join(__dirname, "configs", filename);

    // Check if file exists
    if (!fs.existsSync(configPath)) {
      return res.status(404).json({ error: "Configuration file not found" });
    }

    // Read and send the file
    const fileContent = fs.readFileSync(configPath, 'utf8');
    res.json(JSON.parse(fileContent));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Helper function to format uptime
function formatUptime(ms) {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// Helper function to format file size
function formatFileSize(bytes) {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// Create logs directory if it doesn't exist
if (!fs.existsSync(path.join(__dirname, "logs"))) {
  fs.mkdirSync(path.join(__dirname, "logs"));
}

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: err.message || "Something went wrong!",
    stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
  });
});

app.listen(PORT, () => {
  console.log(`Management server running on port ${PORT}`);
});
