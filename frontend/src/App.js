import React, { useState } from 'react';

import CalendarView from './CalendarView';
import Installers from './Installers';
import ImportJobs from './ImportJobs';
import ControlPanel from './ControlPanel';
import SchedulesTable from './SchedulesTable';
import { CoreHoursProvider } from './CoreHoursContext';

function App() {
  const [tab, setTab] = useState('calendar');
  return (
    <CoreHoursProvider>
      <div style={{ maxWidth: 900, margin: '2rem auto', fontFamily: 'sans-serif' }}>
  <h1>LSI Install Scheduling</h1>
        <nav style={{ marginBottom: 20 }}>
          <button onClick={() => setTab('calendar')}>Calendar</button>
          <button onClick={() => setTab('schedules')}>Schedules Table</button>
          <button onClick={() => setTab('installers')}>Installers</button>
          <button onClick={() => setTab('import')}>Import Jobs</button>
          <button onClick={() => setTab('control')}>Control Panel</button>
        </nav>
        {tab === 'calendar' && <CalendarView />}
        {tab === 'schedules' && <SchedulesTable />}
        {tab === 'installers' && <Installers />}
        {tab === 'import' && <ImportJobs />}
        {tab === 'control' && <ControlPanel />}
      </div>
    </CoreHoursProvider>
  );
}

export default App;
