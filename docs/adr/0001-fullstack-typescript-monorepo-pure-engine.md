# 全栈 TypeScript monorepo + 纯函数引擎

政变规则复杂且会持续迭代，需要一种语言贯穿前后端并让游戏规则可独立演进、独立测试。我们决定采用全栈 TypeScript，以 pnpm monorepo 组织四个包（`engine` / `shared` / `server` / `client`），其中 `engine` 是纯函数、零 I/O 的游戏引擎——不依赖网络、存储或 UI。这样未来更换数据库、前端框架、加 AI 玩家或扩展卡牌都无需改动规则核心。

**Considered Options**: 曾考虑 C#/.NET（`.gitignore` 现有即 Visual Studio 风格）、Go、Python FastAPI。弃用原因：跨语言无法共享类型、前后端心智负担大；单语言 + 共享类型让规则改动时编译器立即暴露所有受影响的调用点。
