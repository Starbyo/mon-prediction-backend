const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const app = express();
const port = process.env.PORT || 3000;
// Supabase setup
const supabase = createClient(
 process.env.SUPABASE_URL,
 process.env.SUPABASE_ANON_KEY
);
app.use(cors());
app.use(express.json());
// Current MON price (simulated)
let currentPrice = 0.245;
// Update price every second
setInterval(() => {
 const change = (Math.random() - 0.5) * 0.002;
 currentPrice = Math.max(0.001, currentPrice + change);
 
 // Store in database every 10 seconds
 if (Math.random() < 0.1) {
 supabase.from('price_history').insert({ price: currentPrice });
 }
}, 1000);
// Health check
app.get('/', (req, res) => {res.json({ 
 message: 'MON Prediction Arena API is running!', 
 price: currentPrice,
 timestamp: new Date().toISOString()
 });
});
// Get current price
app.get('/api/price/current', (req, res) => {
 res.json({ price: currentPrice, timestamp: Date.now() });
});
// Get price history
app.get('/api/price/history', async (req, res) => {
 try {
 const { data, error } = await supabase
 .from('price_history')
 .select('*')
 .order('timestamp', { ascending: false })
 .limit(60);
 
 if (error) throw error;
 res.json(data || []);
 } catch (error) {
 console.error('Error fetching price history:', error);
 res.json([]);
 }
});
// Telegram user authentication
app.post('/api/auth/telegram', async (req, res) => {
 try {
 const { telegram_id, username } = req.body;
 
 // Check if user exists
 let { data: user, error } = await supabase
 .from('users')
 .select('*')
 .eq('telegram_id', telegram_id)
 .single();
 
 if (error && error.code !== 'PGRST116') {
 throw error;
 }
 
 // Create new user if doesn't existif (!user) {
 const { data: newUser, error: insertError } = await supabase
 .from('users')
 .insert({ telegram_id, username })
 .select()
 .single();
 
 if (insertError) throw insertError;
 user = newUser;
 }
 
 res.json(user);
 } catch (error) {
 console.error('Auth error:', error);
 res.status(500).json({ error: 'Authentication failed' });
 }
});
// Make prediction
app.post('/api/game/predict', async (req, res) => {
 try {
 const { telegram_id, prediction, bet_amount } = req.body;
 
 // Get user
 const { data: user, error: userError } = await supabase
 .from('users')
 .select('*')
 .eq('telegram_id', telegram_id)
 .single();
 
 if (userError || !user) {
 return res.status(404).json({ error: 'User not found' });
 }
 
 if (user.balance < bet_amount) {
 return res.status(400).json({ error: 'Insufficient balance' });
 }
 
 if (user.daily_spent + bet_amount > user.daily_limit) {
 return res.status(400).json({ error: 'Daily limit exceeded' });
 }
 
 // Create game
 const { data: game, error: gameError } = await supabase
 .from('games')
 .insert({user_id: user.id,
 prediction,
 bet_amount,
 start_price: currentPrice
 })
 .select()
 .single();
 
 if (gameError) throw gameError;
 
 // Update user balance
 const { error: updateError } = await supabase
 .from('users')
 .update({ 
 balance: user.balance - bet_amount,
 daily_spent: user.daily_spent + bet_amount
 })
 .eq('id', user.id);
 
 if (updateError) throw updateError;
 
 res.json({ game_id: game.id, start_price: currentPrice });
 } catch (error) {
 console.error('Prediction error:', error);
 res.status(500).json({ error: 'Failed to create prediction' });
 }
});
// End game
app.post('/api/game/end/:game_id', async (req, res) => {
 try {
 const { game_id } = req.params;
 
 // Get game with user data
 const { data: game, error: gameError } = await supabase
 .from('games')
 .select(`
 *,
 users (*)
 `)
 .eq('id', game_id)
 .single();
 
 if (gameError || !game) {
 return res.status(404).json({ error: 'Game not found' });
 }if (game.end_price) {
 return res.status(400).json({ error: 'Game already ended' });
 }
 
 // Determine winner
 const priceChange = currentPrice - game.start_price;
 const won = (game.prediction === 'higher' && priceChange > 0) || 
 (game.prediction === 'lower' && priceChange < 0);
 
 const winAmount = won ? Math.floor(game.bet_amount * 2.1) : 0;
 
 // Update game
 const { error: updateGameError } = await supabase
 .from('games')
 .update({ 
 end_price: currentPrice, 
 won,
 ended_at: new Date()
 })
 .eq('id', game_id);
 
 if (updateGameError) throw updateGameError;
 
 // Update user stats
 const newBalance = game.users.balance + winAmount;
 const newGamesPlayed = game.users.games_played + 1;
 const newGamesWon = game.users.games_won + (won ? 1 : 0);
 
 const { error: updateUserError } = await supabase
 .from('users')
 .update({ 
 balance: newBalance,
 games_played: newGamesPlayed,
 games_won: newGamesWon
 })
 .eq('id', game.users.id);
 
 if (updateUserError) throw updateUserError;
 
 res.json({ 
 won, 
 win_amount: winAmount, 
 end_price: currentPrice,
 new_balance: newBalance
});} catch (error) {
 console.error('End game error:', error);
 res.status(500).json({ error: 'Failed to end game' });
 }
});
// Get user game history
app.get('/api/user/:telegram_id/history', async (req, res) => {
 try {
 const { telegram_id } = req.params;
 
 // Get user
 const { data: user, error: userError } = await supabase
 .from('users')
 .select('id')
 .eq('telegram_id', telegram_id)
 .single();
 
 if (userError || !user) {
 return res.status(404).json({ error: 'User not found' });
 }
 
 // Get games
 const { data: games, error: gamesError } = await supabase
 .from('games')
 .select('*')
 .eq('user_id', user.id)
 .order('created_at', { ascending: false })
 .limit(10);
 
 if (gamesError) throw gamesError;
 
 res.json(games || []);
 } catch (error) {
 console.error('History error:', error);
 res.json([]);
 }
});
app.listen(port, () => {
 console.log(`🚀 MON Prediction Arena API running on port ${port}`);
});
