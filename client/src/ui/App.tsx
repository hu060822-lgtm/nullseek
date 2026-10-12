import { useStore } from '../state/store';
import GameScreen from './GameScreen';
import Lobby from './Lobby';
import Menu from './Menu';

function ConnBanner(): JSX.Element | null {
  const session = useStore((s) => s.session);
  const connected = useStore((s) => s.connected);
  const reconnecting = useStore((s) => s.reconnecting);
  if (!session) return null;
  if (connected && !reconnecting) return null;
  return <div className="conn plate" role="status">與伺服器的連線中斷，正在重新連線…（你的角色與進度會保留）</div>;
}

export default function App(): JSX.Element {
  const session = useStore((s) => s.session);
  const room = useStore((s) => s.room);
  let screen: JSX.Element;
  if (!session || !room) screen = <Menu />;
  else if (room.phase === 'LOBBY') screen = <Lobby />;
  else screen = <GameScreen />;
  return (
    <>
      {screen}
      <ConnBanner />
    </>
  );
}
