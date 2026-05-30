# MyCodingAssistant

> Self-learning AI coding assistant with microservice architecture

A locally-hosted AI coding assistant that runs unmanaged with self-healing capabilities, learns and improves continuously, and provides a comprehensive web dashboard for monitoring and control.

## Features

- 💬 **Terminal-like Chat Interface** - Streaming responses with syntax highlighting
- 🧠 **Pi SDK Integration** - Powered by the battle-tested Pi coding agent
- 🎤 **Voice Input/Output** - TTS and STT services for hands-free interaction
- 👁️ **Vision Services** - Face detection, object detection, and webcam integration
- 🎭 **3D Avatar** - Interactive talking head with lipsync animation
- 📊 **Service Dashboard** - Monitor and control all microservices
- 🔄 **Self-Healing** - Automatic failure detection and recovery
- 📈 **Self-Learning** - Continuous improvement through session analysis
- 🔌 **IDE Extension** - VS Code integration for contextual assistance
- 🌐 **REST API** - External integrations with authentication

## Architecture

Built with a microservice architecture where each capability (TTS, STT, detection, etc.) runs as an independent process, managed by a central service orchestrator.

- **Frontend**: Next.js 15 + React 19
- **Backend**: Node.js 22+ with Express + Socket.io
- **AI Core**: @earendil-works/pi-coding-agent SDK
- **Database**: SQLite (local-first)

## Quick Start

```bash
# Install dependencies
npm install

# Start development servers
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Development

```bash
# Run all services in dev mode
npm run dev

# Build for production
npm run build

# Run tests
npm run test

# Lint code
npm run lint

# Format code
npm run format
```

## Project Structure

```
MyCodingAssistant/
├── apps/
│   ├── web/          # Next.js frontend
│   ├── server/       # Backend server
│   └── extension/    # VS Code extension
├── packages/
│   ├── llm-service/           # Pi SDK wrapper
│   ├── tts-service/           # Text-to-speech
│   ├── stt-service/           # Speech-to-text
│   ├── face-detection/        # Face detection
│   ├── object-detection/      # Object detection
│   ├── avatar-3d/             # 3D avatar rendering
│   ├── learning-service/      # Learning & improvement
│   ├── service-manager/       # Process management
│   └── shared/                # Shared types & utilities
└── docs/                      # Documentation
```

## Documentation

- [Project Plan](PROJECT_PLAN.md) - Comprehensive roadmap and architecture
- [API Documentation](docs/api.md) - REST API reference
- [Service Guide](docs/services.md) - Microservice architecture guide
- [User Guide](docs/user-guide.md) - End-user documentation

## Roadmap

See [PROJECT_PLAN.md](PROJECT_PLAN.md) for the full development roadmap:

- **Phase 1-2**: Foundation & Service Architecture
- **Phase 3-4**: TTS/STT & Vision Services
- **Phase 5-6**: 3D Avatar & Learning Layer
- **Phase 7-8**: Dashboard & IDE Extension
- **Phase 9-10**: API Service & Self-Healing
- **Phase 11-12**: Android App & Production

## Contributing

This is a personal project. Feel free to fork and customize for your own needs.

## License

MIT
