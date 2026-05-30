# MyCodingAssistant - Project Plan

> Self-learning, self-improving AI coding assistant with microservice architecture

## Vision

A locally-hosted AI coding assistant that:
- Runs unmanaged with self-healing capabilities
- Learns and improves continuously from interactions
- Provides a web dashboard for monitoring and control
- Integrates multiple AI modalities (voice, vision, 3D avatar)
- Keeps the user in control with safe operation boundaries
- Extensible via Pi SDK, IDE extensions, and API services

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        Frontend (Next.js)                        │
├──────────────┬──────────────┬──────────────┬───────────────────┤
│  Chat Screen │   Dashboard  │  Settings    │   3D Avatar View  │
│  (Terminal)  │  (Services)  │  (Config)    │   (Three.js)      │
└──────────────┴──────────────┴──────────────┴───────────────────┘
                              │
                    WebSocket / REST API
                              │
┌─────────────────────────────────────────────────────────────────┐
│                     Backend (Node.js)                            │
├──────────────────────────────────────────────────────────────┤
│                    Service Manager (Orchestrator)                │
│  - Health monitoring & auto-restart                             │
│  - Service lifecycle management                                 │
│  - Graceful degradation                                         │
│  - Resource allocation                                          │
└──────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
┌───────▼────────┐  ┌────────▼────────┐  ┌────────▼────────┐
│  Core Services │  │  AI Services    │  │  Media Services │
├────────────────┤  ├─────────────────┤  ├─────────────────┤
│ Pi SDK (Brain) │  │ LLM Service     │  │ TTS Service     │
│ Session Mgr    │  │ Model Registry  │  │ STT Service     │
│ Auth Storage   │  │ Thinking Level  │  │ Face Detection  │
│ Extensions     │  │ Custom Tools    │  │ Object Detection│
│ Skills         │  │ Compaction      │  │ 3D Avatar       │
└────────────────┘  └─────────────────┘  └─────────────────┘
                              │
                    ┌─────────▼─────────┐
                    │  Learning Layer   │
                    ├───────────────────┤
                    │ Session Logger    │
                    │ Feedback System   │
                    │ Pattern Analyzer  │
                    │ Auto-Improvement  │
                    └───────────────────┘
```

## Technology Stack

### Frontend
- **Framework**: Next.js 15 (App Router) + React 19
- **Styling**: Tailwind CSS + shadcn/ui components
- **State**: Zustand + React Query
- **Terminal Emulator**: xterm.js (for chat screen)
- **3D Rendering**: Three.js + React Three Fiber
- **Real-time**: WebSocket (Socket.io client)
- **Build**: Turbopack (Next.js default)

### Backend
- **Runtime**: Node.js 22+
- **Framework**: Express.js + Socket.io
- **AI Core**: @earendil-works/pi-coding-agent SDK
- **Service Management**: PM2 or custom process manager
- **Database**: SQLite (lightweight, local-first)
- **Queue**: Bull (for background jobs)

### Services (Microservices)
Each service runs as an independent process:
1. **llm-service**: Pi SDK wrapper, model management
2. **tts-service**: Text-to-speech (Kokoro/Coqui)
3. **stt-service**: Speech-to-text (Whisper/Web Speech API)
4. **face-detection**: MediaPipe BlazeFace
5. **object-detection**: transformers.js + YOLOS
6. **avatar-3d**: Three.js rendering service
7. **learning-service**: Session analysis & improvement

## Project Phases

### Phase 1: Foundation (Week 1-2)
**Goal**: Basic chat interface with Pi SDK integration

**Tasks**:
- [ ] Initialize Next.js project with TypeScript
- [ ] Set up monorepo structure (npm workspaces)
- [ ] Create basic chat screen with terminal-like UI (xterm.js)
- [ ] Implement Pi SDK integration (createAgentSession)
- [ ] Stream responses via WebSocket to frontend
- [ ] Basic session management (new, continue, list)
- [ ] Simple settings panel (model selection, thinking level)

**Deliverables**:
- Working chat interface
- Streaming responses from Pi SDK
- Session persistence

**Acceptance Criteria**:
- Can send message and receive streaming response
- Response appears character-by-character like terminal
- Can switch between models
- Sessions persist across page reloads

---

### Phase 2: Service Architecture (Week 3-4)
**Goal**: Microservice infrastructure with health monitoring

**Tasks**:
- [ ] Design service manager with process spawning
- [ ] Implement service registry and health checks
- [ ] Create service status dashboard
- [ ] Add start/stop/restart controls per service
- [ ] Implement graceful degradation (fallbacks)
- [ ] Add auto-restart on failure (exponential backoff)
- [ ] Service logs viewer
- [ ] Resource monitoring (CPU, memory per service)

**Deliverables**:
- Service manager that can spawn/monitor services
- Dashboard showing all services with status
- Controls to enable/disable services

**Acceptance Criteria**:
- Each service runs as independent process
- Dashboard shows real-time health status
- Services auto-restart on crash
- Can enable/disable services from dashboard

---

### Phase 3: TTS & STT Services (Week 5-6)
**Goal**: Voice input/output capabilities

**Tasks**:
- [ ] Implement TTS service (Kokoro TTS integration)
- [ ] Implement STT service (Whisper or Web Speech API)
- [ ] Add voice input button to chat interface
- [ ] Auto-speak responses toggle
- [ ] Voice activity detection
- [ ] TTS voice selection and settings
- [ ] STT language selection
- [ ] Integrate with service manager

**Deliverables**:
- Working TTS service with multiple voices
- Working STT service with language support
- Voice input/output in chat interface

**Acceptance Criteria**:
- Can speak text via microphone
- Response is spoken aloud (when enabled)
- Can select different voices
- Service can be started/stopped independently

---

### Phase 4: Vision Services (Week 7-8)
**Goal**: Webcam integration with face/object detection

**Tasks**:
- [ ] Implement webcam capture service
- [ ] Face detection service (MediaPipe BlazeFace)
- [ ] Object detection service (transformers.js + YOLOS)
- [ ] Gaze-triggered STT (start listening when looking at camera)
- [ ] Face tracking visualization overlay
- [ ] Object detection overlay with labels
- [ ] Detection confidence thresholds
- [ ] Integrate with service manager

**Deliverables**:
- Live webcam feed with detection overlays
- Face detection triggering STT
- Object detection with bounding boxes

**Acceptance Criteria**:
- Webcam stream visible in interface
- Faces detected and highlighted
- Objects detected and labeled
- STT activates when face is detected
- Services can be enabled/disabled independently

---

### Phase 5: 3D Avatar (Week 9-10)
**Goal**: Interactive 3D talking head avatar

**Tasks**:
- [ ] Implement avatar-3d service (Three.js)
- [ ] Load GLTF avatar models
- [ ] Lipsync animation from TTS visemes
- [ ] Facial expressions (happy, thinking, neutral)
- [ ] Eye tracking (follow cursor or face)
- [ ] Avatar selection (multiple models)
- [ ] Avatar settings (gender, appearance)
- [ ] Integrate with TTS service

**Deliverables**:
- 3D avatar that speaks responses
- Lipsync animation
- Facial expressions
- Avatar customization

**Acceptance Criteria**:
- Avatar visible in dedicated view
- Lips move in sync with TTS
- Avatar shows expressions
- Can switch between avatar models
- Service runs independently

---

### Phase 6: Learning Layer (Week 11-12)
**Goal**: Self-improvement through session analysis

**Tasks**:
- [ ] Session logger (store all interactions)
- [ ] Feedback system (thumbs up/down on responses)
- [ ] Pattern analyzer (common questions, successful responses)
- [ ] Auto-improvement suggestions
- [ ] Learning dashboard (stats, insights)
- [ ] Export/import learning data
- [ ] A/B testing for improvements
- [ ] Safe mode (user approval for changes)

**Deliverables**:
- Session history with search
- Feedback collection
- Pattern analysis reports
- Improvement suggestions

**Acceptance Criteria**:
- All sessions logged and searchable
- Can give feedback on responses
- System identifies patterns
- Suggests improvements with user approval
- Learning data can be exported

---

### Phase 7: Dashboard & Control (Week 13-14)
**Goal**: Comprehensive monitoring and control center

**Tasks**:
- [ ] Service status overview (all services)
- [ ] Resource usage graphs (CPU, memory, network)
- [ ] Service logs with filtering
- [ ] Configuration management UI
- [ ] Backup/restore functionality
- [ ] System health alerts
- [ ] Performance metrics
- [ ] Quick actions (restart all, shutdown)

**Deliverables**:
- Full dashboard with all controls
- Real-time monitoring
- Configuration management
- Backup/restore

**Acceptance Criteria**:
- Can see all services at a glance
- Can control any service
- Can view logs in real-time
- Can backup and restore system
- Alerts shown for issues

---

### Phase 8: IDE Extension (Week 15-16)
**Goal**: VS Code extension for IDE integration

**Tasks**:
- [ ] Create VS Code extension scaffold
- [ ] Connect to local MyCodingAssistant server
- [ ] Chat panel in sidebar
- [ ] Inline code suggestions
- [ ] Code review commands
- [ ] Context-aware assistance
- [ ] Settings synchronization
- [ ] Status bar integration

**Deliverables**:
- Working VS Code extension
- Chat in sidebar
- Inline suggestions
- Code review integration

**Acceptance Criteria**:
- Extension installs in VS Code
- Can chat with assistant from IDE
- Get contextual suggestions
- Code review commands available
- Syncs with web interface

---

### Phase 9: API Service (Week 17-18)
**Goal**: REST API for external integrations

**Tasks**:
- [ ] Design REST API schema
- [ ] Authentication (API keys)
- [ ] Rate limiting
- [ ] Webhook support
- [ ] API documentation (OpenAPI/Swagger)
- [ ] SDK for popular languages (Python, JavaScript)
- [ ] API playground
- [ ] Usage analytics

**Deliverables**:
- Full REST API
- Authentication system
- API documentation
- SDKs for Python and JavaScript

**Acceptance Criteria**:
- API accessible via HTTP
- Proper authentication
- Documented endpoints
- Can use from external applications
- Rate limiting in place

---

### Phase 10: Self-Healing & Autonomy (Week 19-20)
**Goal**: Robust autonomous operation

**Tasks**:
- [ ] Advanced health monitoring
- [ ] Predictive failure detection
- [ ] Self-diagnostic tests
- [ ] Automatic recovery procedures
- [ ] Graceful degradation strategies
- [ ] Resource optimization
- [ ] Scheduled maintenance mode
- [ ] Emergency shutdown procedures

**Deliverables**:
- Self-healing system
- Predictive monitoring
- Automatic recovery
- Maintenance mode

**Acceptance Criteria**:
- System detects issues before they occur
- Automatically recovers from failures
- Degrades gracefully under load
- Can run unattended for extended periods
- Safe emergency procedures

---

### Phase 11: Android Companion App (Week 21-24)
**Goal**: Mobile app for remote access

**Tasks**:
- [ ] React Native setup
- [ ] Connect to local server
- [ ] Chat interface
- [ ] Voice input/output
- [ ] Camera integration
- [ ] Push notifications
- [ ] Offline mode
- [ ] Settings sync

**Deliverables**:
- Android app with core features
- Chat on mobile
- Voice interaction
- Camera access

**Acceptance Criteria**:
- App installs on Android
- Can chat with assistant
- Voice input/output works
- Camera detection available
- Works over network

---

### Phase 12: Polish & Production (Week 25-26)
**Goal**: Production-ready system

**Tasks**:
- [ ] Comprehensive testing (unit, integration, e2e)
- [ ] Performance optimization
- [ ] Security audit
- [ ] Documentation (user guide, API docs, admin guide)
- [ ] Deployment scripts
- [ ] Monitoring and alerting
- [ ] Backup strategy
- [ ] User onboarding flow

**Deliverables**:
- Production-ready system
- Complete documentation
- Deployment automation
- Monitoring setup

**Acceptance Criteria**:
- All tests passing
- Performance benchmarks met
- Security vulnerabilities addressed
- Documentation complete
- Easy deployment
- User-friendly onboarding

## Directory Structure

```
MyCodingAssistant/
├── apps/
│   ├── web/                    # Next.js frontend
│   │   ├── src/
│   │   │   ├── app/           # App router pages
│   │   │   ├── components/    # React components
│   │   │   ├── lib/           # Utilities
│   │   │   └── styles/        # CSS
│   │   └── package.json
│   ├── server/                 # Backend server
│   │   ├── src/
│   │   │   ├── api/           # REST endpoints
│   │   │   ├── websocket/     # Socket.io handlers
│   │   │   ├── services/      # Service manager
│   │   │   └── lib/           # Utilities
│   │   └── package.json
│   └── extension/              # VS Code extension
│       ├── src/
│       └── package.json
├── packages/
│   ├── llm-service/           # Pi SDK wrapper
│   ├── tts-service/           # Text-to-speech
│   ├── stt-service/           # Speech-to-text
│   ├── face-detection/        # Face detection
│   ├── object-detection/      # Object detection
│   ├── avatar-3d/             # 3D avatar rendering
│   ├── learning-service/      # Learning & improvement
│   ├── service-manager/       # Process management
│   └── shared/                # Shared types & utils
├── docs/                       # Documentation
├── scripts/                    # Build & deployment scripts
├── .github/                    # CI/CD workflows
├── PROJECT_PLAN.md            # This file
├── package.json               # Root workspace config
└── README.md
```

## Key Design Decisions

### 1. Microservice Architecture
**Why**: Each service (TTS, STT, detection, etc.) has different resource requirements and failure modes. Independent processes allow:
- Granular control (enable/disable individual services)
- Fault isolation (one service crash doesn't affect others)
- Resource optimization (only run what's needed)
- Independent updates and scaling

### 2. Local-First
**Why**: Privacy, control, and reliability:
- All data stays on user's machine
- Works offline
- No external dependencies
- User has full control

### 3. Pi SDK as Core
**Why**: Battle-tested AI agent framework with:
- Streaming responses
- Tool system
- Extension support
- Session management
- Multiple model support

### 4. Terminal-Like Chat
**Why**: Familiar to developers, efficient, and clear:
- Streaming text like terminal output
- Syntax highlighting
- Markdown rendering
- Copy-paste friendly

### 5. Self-Healing
**Why**: Unattended operation requires:
- Automatic failure detection
- Graceful degradation
- Auto-restart with backoff
- Predictive monitoring

## Safety & Control

### User Control Boundaries
- All services can be disabled via dashboard
- Learning system requires user approval for changes
- Safe mode prevents automatic modifications
- Emergency shutdown available at all times
- Clear visibility into what's running

### Data Privacy
- All data stored locally
- No external data transmission (unless explicitly enabled)
- Encrypted storage for sensitive data
- User can delete all data at any time

### Resource Limits
- Configurable CPU/memory limits per service
- Automatic resource throttling
- Queue management for high load
- Graceful request dropping

## Success Metrics

### Phase 1-4 (MVP)
- Chat interface working with streaming responses
- Pi SDK integrated and functional
- At least 2 services (TTS + STT) operational
- Dashboard showing service status
- Basic session management

### Phase 5-8 (Enhanced)
- 3D avatar with lipsync
- Face/object detection working
- Learning system collecting data
- IDE extension functional
- API available for external use

### Phase 9-12 (Production)
- Self-healing operational
- Android app available
- Full documentation
- Production deployment ready
- Performance benchmarks met

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Pi SDK breaking changes | High | Pin version, create adapter layer |
| Resource exhaustion | High | Resource limits, monitoring, throttling |
| Service crashes | Medium | Auto-restart, graceful degradation |
| Learning system errors | Medium | Safe mode, user approval, rollback |
| Security vulnerabilities | High | Regular audits, sandboxing, encryption |
| Performance issues | Medium | Profiling, optimization, caching |

## Getting Started

### Prerequisites
- Node.js 22+
- npm 10+
- Git
- LM Studio (for local LLM)

### Initial Setup
```bash
# Clone repository
git clone https://github.com/Struis112/MyCodingAssistant.git
cd MyCodingAssistant

# Install dependencies
npm install

# Start development
npm run dev
```

### Development Commands
```bash
npm run dev          # Start all services in dev mode
npm run build        # Build for production
npm run test         # Run tests
npm run lint         # Lint code
npm run format       # Format code
```

## Next Steps

1. **Initialize project structure** (this session)
2. **Set up Next.js frontend** with basic layout
3. **Implement Pi SDK integration** in backend
4. **Create chat screen** with terminal-like streaming
5. **Connect frontend to backend** via WebSocket
6. **Basic session management**

Ready to start building! 🚀
