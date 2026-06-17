import { Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import Record from './pages/Record';
import MeetingView from './pages/MeetingView';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Record />} />
        <Route path="/m/:id" element={<MeetingView />} />
      </Route>
    </Routes>
  );
}
