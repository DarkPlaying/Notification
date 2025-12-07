
import { initializeApp, cert } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { getDatabase } from 'firebase-admin/database';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import http from 'http';
import https from 'https';

// Load service account from Environment Variable
const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!serviceAccountRaw) {
    console.error('ERROR: FIREBASE_SERVICE_ACCOUNT environment variable is missing.');
    process.exit(1);
}

const serviceAccount = JSON.parse(serviceAccountRaw);

initializeApp({
    credential: cert(serviceAccount),
    databaseURL: "https://education-ai-af34e-default-rtdb.firebaseio.com"
});

const db = getDatabase();
const messaging = getMessaging();
const firestore = getFirestore();

console.log('Notification Server Started...');
console.log('Listening for new notifications in Realtime Database...');

const notificationsRef = db.ref('notifications');
const activeListeners = new Set();

// Listen for new notifications added to any user
notificationsRef.on('child_added', (userSnapshot) => {
    const userId = userSnapshot.key;

    if (activeListeners.has(userId)) {
        return; // Already listening for this user
    }
    activeListeners.add(userId);
    console.log(`Attaching listener for user ${userId}`);

    const userNotifRef = db.ref(`notifications/${userId}`);

    userNotifRef.on('child_added', async (snapshot) => {
        const notification = snapshot.val();
        const notifId = snapshot.key;

        if (notification.processed) return;

        // Check if it's too old (older than 5 minutes)
        if (Date.now() - notification.timestamp > 5 * 60 * 1000) return;

        console.log(`Processing notification for user ${userId}:`, JSON.stringify(notification));

        try {
            console.log(`Fetching user document for ${userId}...`);
            const userDoc = await firestore.collection('users').doc(userId).get();

            if (userDoc.exists) {
                const userData = userDoc.data();
                const fcmToken = userData.fcmToken;
                console.log(`User ${userId} found. Token exists: ${!!fcmToken}`);

                if (fcmToken) {
                    const message = {
                        token: fcmToken,
                        // notification: { ... }  <-- REMOVED to prevent auto-display
                        data: {
                            title: notification.title,
                            body: notification.body,
                            url: notification.link || '/',
                            type: notification.type || 'info', // Pass type
                            icon: 'https://educationfyp.vercel.app/report.png'
                        },
                        webpush: {
                            fcm_options: {
                                link: notification.link || '/'
                            }
                        }
                    };

                    try {
                        console.log(`Sending FCM message to ${userId}...`);
                        const response = await messaging.send(message);
                        console.log('Successfully sent message:', response);

                        // Mark as processed
                        await userNotifRef.child(notifId).update({ processed: true });
                        console.log(`Marked notification ${notifId} as processed.`);

                    } catch (error) {
                        console.error('Error sending FCM message:', error);
                    }
                } else {
                    console.log(`No FCM token for user ${userId}`);
                }
            } else {
                console.log(`User document ${userId} does not exist.`);
            }
        } catch (error) {
            console.error("Error fetching user data:", error);
        }
    });
});

// Create a simple HTTP server
const port = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
    }

    if (req.method === 'POST' && req.url === '/delete-user') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const { email } = JSON.parse(body);
                if (!email) throw new Error('Email is required');

                console.log(`[Auth] Attempting to delete user by email: ${email}`);
                const userRecord = await getAuth().getUserByEmail(email);
                await getAuth().deleteUser(userRecord.uid);

                console.log(`[Auth] Successfully deleted user ${email} (${userRecord.uid})`);
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ success: true, message: 'User deleted from Auth' }));
            } catch (error) {
                console.error('[Auth] Error deleting user:', error);

                // If user not found, strictly speaking it's a success for us (they are gone)
                if (error.code === 'auth/user-not-found') {
                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ success: true, message: 'User already deleted' }));
                } else {
                    res.statusCode = 500;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ success: false, error: error.message }));
                }
            }
        });
        return;
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Notification Service is Running\n');
});

server.listen(port, () => {
    console.log(`Server running at port ${port}`);

    // Keep-Alive Mechanism
    // Pings the server every 14 minutes to prevent Render from sleeping
    const SERVER_URL = 'https://edu-online-notifications.onrender.com';

    setInterval(() => {
        console.log(`Sending keep-alive ping to ${SERVER_URL}`);
        https.get(SERVER_URL, (res) => {
            console.log(`Keep-alive ping status: ${res.statusCode}`);
        }).on('error', (e) => {
            console.error(`Keep-alive ping failed: ${e.message}`);
        });
    }, 14 * 60 * 1000); // 14 minutes
});
