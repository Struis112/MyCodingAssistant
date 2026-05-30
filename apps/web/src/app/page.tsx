import { Metadata } from 'next';
import Link from 'next/link';
import {
  Bot,
  Terminal,
  Sparkles,
  Zap,
  Shield,
  GitBranch,
  MessageSquare,
  ChevronRight,
  Github,
  ArrowRight,
  CheckCircle2,
  Code2,
  Brain,
  Workflow,
} from 'lucide-react';

export const metadata: Metadata = {
  title: 'MyCodingAssistant - Self-Learning AI Coding Assistant',
  description:
    'A locally-hosted AI coding assistant that learns, improves, and heals itself. Built with Pi SDK, featuring voice control, 3D avatars, and computer vision.',
};

export default function HomePage() {
  return (
    <main className="min-h-screen bg-background">
      {/* Navigation */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-background/80 backdrop-blur-md border-b border-border">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-2">
              <Bot className="w-8 h-8 text-primary" />
              <span className="text-xl font-bold">MyCodingAssistant</span>
            </div>
            <div className="hidden md:flex items-center gap-8">
              <Link
                href="#features"
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                Features
              </Link>
              <Link
                href="#architecture"
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                Architecture
              </Link>
              <Link
                href="#getting-started"
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                Get Started
              </Link>
              <Link
                href="https://github.com/Struis112/MyCodingAssistant"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors"
              >
                <Github className="w-5 h-5" />
                GitHub
              </Link>
            </div>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="pt-32 pb-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          <div className="text-center space-y-8">
            <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-primary/10 border border-primary/20">
              <Sparkles className="w-4 h-4 text-primary" />
              <span className="text-sm font-medium text-primary">
                Self-Learning AI Assistant
              </span>
            </div>

            <h1 className="text-5xl md:text-7xl font-bold tracking-tight">
              Bring engineering rigor to
              <br />
              <span className="text-primary">AI-powered development</span>
            </h1>

            <p className="text-xl text-muted-foreground max-w-3xl mx-auto leading-relaxed">
              A locally-hosted AI coding assistant that learns from your workflow, improves
              continuously, and heals itself. Manage intent, complete long-running tasks, and
              validate code correctness with an agent that learns how you work.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
              <Link
                href="#getting-started"
                className="flex items-center gap-2 px-8 py-4 bg-primary text-primary-foreground rounded-lg font-semibold hover:bg-primary/90 transition-colors"
              >
                Get Started
                <ArrowRight className="w-5 h-5" />
              </Link>
              <Link
                href="https://github.com/Struis112/MyCodingAssistant"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-2 px-8 py-4 border border-border rounded-lg font-semibold hover:bg-accent transition-colors"
              >
                <Github className="w-5 h-5" />
                View on GitHub
              </Link>
            </div>
          </div>

          {/* Feature highlights */}
          <div className="mt-20 grid grid-cols-1 md:grid-cols-3 gap-6">
            <FeatureCard
              icon={<Terminal className="w-6 h-6" />}
              title="Terminal-Native"
              description="Work directly from your terminal with streaming responses and natural conversation flow."
            />
            <FeatureCard
              icon={<Brain className="w-6 h-6" />}
              title="Self-Learning"
              description="Learns from your coding patterns, preferences, and feedback to improve over time."
            />
            <FeatureCard
              icon={<Shield className="w-6 h-6" />}
              title="Self-Healing"
              description="Automatically detects and recovers from failures with intelligent retry strategies."
            />
          </div>
        </div>
      </section>

      {/* Features Section */}
      <section id="features" className="py-20 px-4 sm:px-6 lg:px-8 bg-accent/5">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl font-bold mb-4">Everything you need to ship faster</h2>
            <p className="text-xl text-muted-foreground">
              Built for working with AI agents, not against them
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <FeatureBlock
              icon={<MessageSquare className="w-8 h-8 text-primary" />}
              title="Spec-Driven Development"
              description="Turn natural language prompts into clear requirements and acceptance criteria. Make your intent explicit with executable specs that guide the AI agent."
              bullets={[
                'Natural language to structured requirements',
                'Acceptance criteria in EARS notation',
                'Iterative refinement workflow',
              ]}
            />
            <FeatureBlock
              icon={<Workflow className="w-8 h-8 text-primary" />}
              title="Microservice Architecture"
              description="Each capability runs as an independent service. Enable, disable, and update components on the fly without affecting the whole system."
              bullets={[
                'Independent service lifecycle',
                'Hot-reload capabilities',
                'Graceful degradation',
              ]}
            />
            <FeatureBlock
              icon={<Code2 className="w-8 h-8 text-primary" />}
              title="Advanced Context Management"
              description="With specs, steering, and smart context management, understand the intent behind your prompts and implement complex features accurately."
              bullets={[
                'Project-aware context',
                'Persistent memory across sessions',
                'Intelligent context selection',
              ]}
            />
            <FeatureBlock
              icon={<Bot className="w-8 h-8 text-primary" />}
              title="3D Avatar Interface"
              description="Interact with a lifelike 3D avatar that responds with voice and visual feedback. Makes coding assistance more engaging and intuitive."
              bullets={[
                'Real-time lip-sync',
                'Expressive animations',
                'Customizable appearance',
              ]}
            />
            <FeatureBlock
              icon={<Zap className="w-8 h-8 text-primary" />}
              title="Computer Vision"
              description="Face detection triggers voice input, object detection for context, and visual understanding of your development environment."
              bullets={[
                'Face detection for activation',
                'Object detection for context',
                'Visual environment awareness',
              ]}
            />
            <FeatureBlock
              icon={<GitBranch className="w-8 h-8 text-primary" />}
              title="Git Integration"
              description="Seamless Git workflow integration. Create branches, commit changes, and manage your version control directly through the assistant."
              bullets={[
                'Automatic branch creation',
                'Semantic commit messages',
                'PR generation and review',
              ]}
            />
          </div>
        </div>
      </section>

      {/* Architecture Section */}
      <section id="architecture" className="py-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <h2 className="text-4xl font-bold mb-4">Built for scale and reliability</h2>
            <p className="text-xl text-muted-foreground">
              Modern architecture designed for production workloads
            </p>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 items-center">
            <div className="space-y-6">
              <div className="space-y-4">
                <h3 className="text-2xl font-bold">Next.js + React Frontend</h3>
                <p className="text-muted-foreground leading-relaxed">
                  Clean, responsive interface built with Next.js 15 and React 19. Server-side
                  rendering, optimistic updates, and real-time WebSocket communication for a
                  seamless experience.
                </p>
              </div>

              <div className="space-y-4">
                <h3 className="text-2xl font-bold">Pi SDK Integration</h3>
                <p className="text-muted-foreground leading-relaxed">
                  Powered by the battle-tested Pi SDK for AI agent capabilities. Streaming
                  responses, tool execution, and advanced context management out of the box.
                </p>
              </div>

              <div className="space-y-4">
                <h3 className="text-2xl font-bold">Service-Based Architecture</h3>
                <p className="text-muted-foreground leading-relaxed">
                  Each feature (TTS, STT, 3D Avatar, Face Detection, Object Detection) runs as an
                  independent service. Start, stop, and update components without affecting the
                  whole system.
                </p>
              </div>
            </div>

            <div className="bg-accent rounded-lg p-8 border border-border">
              <pre className="text-sm text-foreground overflow-x-auto">
                <code>{`┌─────────────────────────────────────┐
│         Next.js Frontend            │
│  (React 19, WebSocket, Tailwind)    │
└─────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────┐
│       Pi SDK (Core Engine)          │
│  • Streaming responses              │
│  • Tool execution                   │
│  • Context management               │
└─────────────────────────────────────┘
                 │
    ┌────────────┼────────────┐
    │            │            │
    ▼            ▼            ▼
┌────────┐  ┌────────┐  ┌────────┐
│  TTS   │  │  STT   │  │ Avatar │
│Service │  │Service │  │Service │
└────────┘  └────────┘  └────────┘
    │            │            │
    ▼            ▼            ▼
┌────────┐  ┌────────┐  ┌────────┐
│  Face  │  │ Object │  │  Git   │
│Detection│ │Detection│ │Integration│
└────────┘  └────────┘  └────────┘`}</code>
              </pre>
            </div>
          </div>
        </div>
      </section>

      {/* Getting Started Section */}
      <section id="getting-started" className="py-20 px-4 sm:px-6 lg:px-8 bg-accent/5">
        <div className="max-w-4xl mx-auto">
          <div className="text-center mb-12">
            <h2 className="text-4xl font-bold mb-4">Get started in minutes</h2>
            <p className="text-xl text-muted-foreground">
              From clone to your first conversation in three simple steps
            </p>
          </div>

          <div className="space-y-8">
            <StepCard
              number={1}
              title="Clone the repository"
              description="Get the source code from GitHub"
              code="git clone https://github.com/Struis112/MyCodingAssistant.git&#10;cd MyCodingAssistant"
            />

            <StepCard
              number={2}
              title="Install dependencies"
              description="Install all required packages"
              code="npm install"
            />

            <StepCard
              number={3}
              title="Start the development server"
              description="Launch both frontend and backend services"
              code="npm run dev"
            />

            <div className="text-center pt-8">
              <p className="text-muted-foreground mb-4">
                That's it! Open{' '}
                <code className="px-2 py-1 bg-accent rounded text-primary font-mono">
                  http://localhost:3000
                </code>{' '}
                in your browser.
              </p>
              <Link
                href="https://github.com/Struis112/MyCodingAssistant"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-2 text-primary hover:text-primary/80 transition-colors font-semibold"
              >
                View full documentation
                <ChevronRight className="w-4 h-4" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* CTA Section */}
      <section className="py-20 px-4 sm:px-6 lg:px-8">
        <div className="max-w-4xl mx-auto text-center">
          <h2 className="text-4xl font-bold mb-4">Ready to transform your workflow?</h2>
          <p className="text-xl text-muted-foreground mb-8">
            Join developers shipping faster with AI-powered assistance
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <Link
              href="#getting-started"
              className="flex items-center gap-2 px-8 py-4 bg-primary text-primary-foreground rounded-lg font-semibold hover:bg-primary/90 transition-colors"
            >
              Get Started Now
              <ArrowRight className="w-5 h-5" />
            </Link>
            <Link
              href="https://github.com/Struis112/MyCodingAssistant"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-8 py-4 border border-border rounded-lg font-semibold hover:bg-accent transition-colors"
            >
              <Github className="w-5 h-5" />
              Star on GitHub
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border py-12 px-4 sm:px-6 lg:px-8">
        <div className="max-w-7xl mx-auto">
          <div className="flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <Bot className="w-6 h-6 text-primary" />
              <span className="font-semibold">MyCodingAssistant</span>
            </div>
            <p className="text-sm text-muted-foreground">
              Built with Pi SDK, Next.js, and React. Self-learning, self-improving, self-healing.
            </p>
            <div className="flex items-center gap-4">
              <Link
                href="https://github.com/Struis112/MyCodingAssistant"
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                <Github className="w-5 h-5" />
              </Link>
            </div>
          </div>
        </div>
      </footer>
    </main>
  );
}

function FeatureCard({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="p-6 rounded-lg border border-border bg-card hover:border-primary/50 transition-colors">
      <div className="flex items-start gap-4">
        <div className="p-2 rounded-lg bg-primary/10 text-primary">{icon}</div>
        <div>
          <h3 className="font-semibold mb-2">{title}</h3>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      </div>
    </div>
  );
}

function FeatureBlock({
  icon,
  title,
  description,
  bullets,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  bullets: string[];
}) {
  return (
    <div className="p-8 rounded-lg border border-border bg-card">
      <div className="mb-4">{icon}</div>
      <h3 className="text-2xl font-bold mb-3">{title}</h3>
      <p className="text-muted-foreground mb-4 leading-relaxed">{description}</p>
      <ul className="space-y-2">
        {bullets.map((bullet, index) => (
          <li key={index} className="flex items-start gap-2">
            <CheckCircle2 className="w-5 h-5 text-primary mt-0.5 flex-shrink-0" />
            <span className="text-sm text-muted-foreground">{bullet}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StepCard({
  number,
  title,
  description,
  code,
}: {
  number: number;
  title: string;
  description: string;
  code: string;
}) {
  return (
    <div className="p-6 rounded-lg border border-border bg-card">
      <div className="flex items-start gap-4">
        <div className="flex items-center justify-center w-10 h-10 rounded-full bg-primary text-primary-foreground font-bold text-lg flex-shrink-0">
          {number}
        </div>
        <div className="flex-1">
          <h3 className="text-xl font-bold mb-2">{title}</h3>
          <p className="text-muted-foreground mb-4">{description}</p>
          <pre className="p-4 bg-accent rounded-lg border border-border overflow-x-auto">
            <code className="text-sm font-mono text-foreground whitespace-pre-wrap">{code}</code>
          </pre>
        </div>
      </div>
    </div>
  );
}
