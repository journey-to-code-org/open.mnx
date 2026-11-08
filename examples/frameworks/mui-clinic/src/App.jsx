// Book a visit: MUI for the layout, the form and its controls; Zubra components for the doctor
// cards and the time picker, styled with MUI's theme through its CSS variables.
import { useMemo, useState } from 'react';
import {
  Alert, AppBar, Box, Button, Container, CssBaseline, FormControl, FormHelperText, FormLabel, Grid, MenuItem, Paper,
  Stack, TextField, ToggleButton, ToggleButtonGroup, Toolbar, Typography,
} from '@mui/material';
import { ThemeProvider, createTheme, useColorScheme } from '@mui/material/styles';
import DoctorCard from './zubra/doctor-card.zb';
import SlotPicker from './zubra/slot-picker.zb';
import { days, doctors, slotsFor } from './data.js';

const BRANDS = { teal: '#00796b', indigo: '#3949ab' };

// `cssVariables` makes MUI write its theme as CSS variables (--mui-palette-primary-main, …) on
// <html>, switched by a class for the colour scheme: what the Zubra components read.
const themeFor = (brand) => createTheme({
  cssVariables: { colorSchemeSelector: 'class' },
  colorSchemes: {
    light: { palette: { primary: { main: BRANDS[brand] } } },
    dark: { palette: { primary: { main: brand === 'teal' ? '#4db6ac' : '#7986cb' } } },
  },
  shape: { borderRadius: 10 },
});

export default function App() {
  const [brand, setBrand] = useState('teal');
  const theme = useMemo(() => themeFor(brand), [brand]);
  return (
    <ThemeProvider theme={theme} defaultMode="light">
      <CssBaseline />
      <Clinic brand={brand} setBrand={setBrand} />
    </ThemeProvider>
  );
}

function Clinic({ brand, setBrand }) {
  const { mode, setMode } = useColorScheme();
  const [doctor, setDoctor] = useState(null);
  const [day, setDay] = useState(days[1]);
  const [time, setTime] = useState('');
  const [missingTime, setMissingTime] = useState(false);
  const [booked, setBooked] = useState(null);
  const slots = useMemo(() => slotsFor(doctor, day), [doctor, day]);

  function choose(id) {
    setDoctor(id);
    setTime('');
  }
  function submit(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    // The Zubra picker is a form control: its value comes with the form's other fields.
    if (!data.get('time')) return setMissingTime(true);
    setMissingTime(false);
    setBooked({ name: data.get('name'), doctor: doctors.find((entry) => entry.id === doctor).name, day, time: data.get('time'), reason: data.get('reason') });
  }

  return (
    <Box sx={{ minHeight: '100vh', bgcolor: 'background.default' }}>
      <AppBar position="static" elevation={0}>
        <Toolbar sx={{ gap: 2 }}>
          <Typography variant="h6" sx={{ flexGrow: 1, fontWeight: 600 }}>Riverside Clinic</Typography>
          <ToggleButtonGroup size="small" exclusive value={brand} onChange={(_, value) => value && setBrand(value)} aria-label="Brand colour"
            sx={{ bgcolor: 'rgba(255,255,255,0.15)', '& .MuiToggleButton-root': { color: 'inherit', borderColor: 'rgba(255,255,255,0.3)' }, '& .Mui-selected': { bgcolor: 'rgba(255,255,255,0.3) !important', color: 'inherit !important' } }}>
            <ToggleButton value="teal">Teal</ToggleButton>
            <ToggleButton value="indigo">Indigo</ToggleButton>
          </ToggleButtonGroup>
          <Button color="inherit" variant="outlined" size="small" onClick={() => setMode(mode === 'dark' ? 'light' : 'dark')}>
            {mode === 'dark' ? 'Light mode' : 'Dark mode'}
          </Button>
        </Toolbar>
      </AppBar>

      <Container maxWidth="md" sx={{ py: 4 }}>
        <Typography variant="h4" component="h1" gutterBottom sx={{ fontWeight: 600 }}>Book a visit</Typography>
        <Typography color="text.secondary" sx={{ mb: 3 }}>MUI's layout and form, with Zubra components for the doctors and the times.</Typography>

        {booked ? (
          <Alert severity="success" role="status" action={<Button color="inherit" size="small" onClick={() => setBooked(null)}>Book another</Button>}>
            {booked.name}, you're booked with {booked.doctor} on {booked.day} at {booked.time} ({booked.reason}).
          </Alert>
        ) : (
          <Paper component="form" onSubmit={submit} noValidate variant="outlined" sx={{ p: { xs: 2, sm: 3 } }}>
            <Stack spacing={3}>
              <FormControl component="fieldset">
                <FormLabel component="legend" sx={{ mb: 1.5 }}>Doctor</FormLabel>
                <Grid container spacing={2}>
                  {doctors.map((entry) => (
                    <Grid key={entry.id} size={{ xs: 12, sm: 4 }}>
                      <DoctorCard doctor={entry} selected={entry.id === doctor} data-id={entry.id} onChoose={(event) => choose(event.detail)} />
                    </Grid>
                  ))}
                </Grid>
              </FormControl>

              <FormControl>
                <FormLabel sx={{ mb: 1 }} id="day-label">Day</FormLabel>
                <ToggleButtonGroup exclusive value={day} onChange={(_, value) => value && (setDay(value), setTime(''))} aria-labelledby="day-label" color="primary" size="small" sx={{ flexWrap: 'wrap' }}>
                  {days.map((name) => <ToggleButton key={name} value={name}>{name}</ToggleButton>)}
                </ToggleButtonGroup>
              </FormControl>

              <FormControl error={missingTime}>
                <FormLabel sx={{ mb: 1 }}>Time</FormLabel>
                <SlotPicker name="time" label="Time" slots={slots} value={time} onValueChange={(event) => { setTime(event.detail); setMissingTime(false); }} />
                {missingTime && <FormHelperText>Choose a time.</FormHelperText>}
              </FormControl>

              <Grid container spacing={2}>
                <Grid size={{ xs: 12, sm: 6 }}><TextField name="name" label="Your name" required fullWidth defaultValue="Sam Rivera" /></Grid>
                <Grid size={{ xs: 12, sm: 6 }}>
                  <TextField name="reason" label="Reason" select fullWidth defaultValue="Check-up">
                    {['Check-up', 'Follow-up', 'New concern'].map((reason) => <MenuItem key={reason} value={reason}>{reason}</MenuItem>)}
                  </TextField>
                </Grid>
              </Grid>

              <Box><Button type="submit" variant="contained" size="large" disabled={!doctor}>Book appointment</Button></Box>
            </Stack>
          </Paper>
        )}
      </Container>
    </Box>
  );
}
