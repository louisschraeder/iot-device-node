'use strict';
const obj = '{}';
// [START iot_mqtt_include]
const {readFileSync} = require('fs');
const jwt = require('jsonwebtoken');
const mqtt = require('mqtt');
// [END iot_mqtt_include]

// The initial backoff time after a disconnection occurs, in seconds.
const MINIMUM_BACKOFF_TIME = 1;

// The maximum backoff time before giving up, in seconds.
const MAXIMUM_BACKOFF_TIME = 32;

// Whether to wait with exponential backoff before publishing.
let shouldBackoff = false;

// The current backoff time.
let backoffTime = 1;

// Whether an asynchronous publish chain is in progress.
let publishChainInProgress = false;

console.log('Google Cloud IoT Core MQTT example.');

// Create a Cloud IoT Core JWT for the given project id, signed with the given
// private key.
// [START iot_mqtt_jwt]
const createJwt = (projectId, privateKeyFile, algorithm) => {
    // Create a JWT to authenticate this device. The device will be disconnected
    // after the token expires, and will have to reconnect with a new token. The
    // audience field should always be set to the GCP project id.
    const token = {
        iat: parseInt(Date.now() / 1000),
        exp: parseInt(Date.now() / 1000) + 20 * 60, // 20 minutes
        aud: projectId,
    };
    const privateKey = readFileSync(privateKeyFile);
    return jwt.sign(token, privateKey, {algorithm: algorithm});
};
// [END iot_mqtt_jwt]



// Publish numMessages messages asynchronously, starting from message
// messagesSent.
// [START iot_mqtt_publish]
const publishAsync = (
    mqttTopic,
    client,
    iatTime,
    messagesSent,
    numMessages,
    connectionArgs
) => {
    // If we have published enough messages or backed off too many times, stop.
    if (messagesSent > numMessages || backoffTime >= MAXIMUM_BACKOFF_TIME) {
        if (backoffTime >= MAXIMUM_BACKOFF_TIME) {
            console.log('Backoff time is too high. Giving up.');
        }
        console.log('Closing connection to MQTT. Goodbye!');
        client.end();
        publishChainInProgress = false;
        return;
    }

    // Publish and schedule the next publish.
    publishChainInProgress = true;
    let publishDelayMs = 0;
    if (shouldBackoff) {
        publishDelayMs = 1000 * (backoffTime + Math.random());
        backoffTime *= 2;
        console.log(`Backing off for ${publishDelayMs}ms before publishing.`);
    }

    setTimeout(() => {
        const payload = `${argv.registryId}/${argv.deviceId}-payload-${messagesSent}`;

        // Publish "payload" to the MQTT topic. qos=1 means at least once delivery.
        // Cloud IoT Core also supports qos=0 for at most once delivery.
        console.log('Publishing message:', payload);
        client.publish(mqttTopic, payload, {qos: 1}, err => {
            if (!err) {
                shouldBackoff = false;
                backoffTime = MINIMUM_BACKOFF_TIME;
            }
        });

        const schedulePublishDelayMs = argv.messageType === 'events' ? 1000 : 2000;
        setTimeout(() => {
            const secsFromIssue = parseInt(Date.now() / 1000) - iatTime;
            if (secsFromIssue > argv.tokenExpMins * 60) {
                iatTime = parseInt(Date.now() / 1000);
                console.log(`\tRefreshing token after ${secsFromIssue} seconds.`);

                client.end();
                connectionArgs.password = createJwt(
                    argv.projectId,
                    argv.privateKeyFile,
                    argv.algorithm
                );
                connectionArgs.protocolId = 'MQTT';
                connectionArgs.protocolVersion = 4;
                connectionArgs.clean = true;
                client = mqtt.connect(connectionArgs);

                client.on('connect', success => {
                    console.log('connect');
                    if (!success) {
                        console.log('Client not connected...');
                    } else if (!publishChainInProgress) {
                        publishAsync(
                            mqttTopic,
                            client,
                            iatTime,
                            messagesSent,
                            numMessages,
                            connectionArgs
                        );
                    }
                });

                client.on('close', () => {
                    console.log('close');
                    shouldBackoff = true;
                });

                client.on('error', err => {
                    console.log('error', err);
                });

                client.on('message', (topic, message) => {
                    console.log(
                        'message received: ',
                        Buffer.from(message, 'base64').toString('ascii')
                    );
                });

                client.on('packetsend', () => {
                    // Note: logging packet send is very verbose
                });
            }
            publishAsync(
                mqttTopic,
                client,
                iatTime,
                messagesSent + 1,
                numMessages,
                connectionArgs
            );
        }, schedulePublishDelayMs);
    }, publishDelayMs);
};
// [END iot_mqtt_publish]


//[Start Example]
const deviceId = `raspi-device`;
const registryId = `louissch`;
const projectId = 'ace-lotus-321217';
const region = `europe-west1`;
const algorithm = `RS256`;
const privateKeyFile = `./rsa_private.pem`;
const serverCertFile = `./roots.pem`;
const mqttBridgeHostname = `mqtt.googleapis.com`;
const mqttBridgePort = 8883;
const messageType = `events`;
const numMessages = 100;

// The mqttClientId is a unique string that identifies this device. For Google
// Cloud IoT Core, it must be in the format below.
const mqttClientId = `projects/${projectId}/locations/${region}/registries/${registryId}/devices/${deviceId}`;

// With Google Cloud IoT Core, the username field is ignored, however it must be
// non-empty. The password field is used to transmit a JWT to authorize the
// device. The "mqtts" protocol causes the library to connect using SSL, which
// is required for Cloud IoT Core.
const connectionArgs = {
    host: mqttBridgeHostname,
    port: mqttBridgePort,
    clientId: mqttClientId,
    username: 'unused',
    password: createJwt(projectId, privateKeyFile, algorithm),
    protocol: 'mqtts',
    secureProtocol: 'TLSv1_2_method',
    ca: [readFileSync(serverCertFile)],
};

// Create a client, and connect to the Google MQTT bridge.
const iatTime = parseInt(Date.now() / 1000);
const client = mqtt.connect(connectionArgs);

// Subscribe to the /devices/{device-id}/config topic to receive config updates.
// Config updates are recommended to use QoS 1 (at least once delivery)
client.subscribe(`/devices/${deviceId}/config`, {qos: 1});

// Subscribe to the /devices/{device-id}/commands/# topic to receive all
// commands or to the /devices/{device-id}/commands/<subfolder> to just receive
// messages published to a specific commands folder; we recommend you use
// QoS 0 (at most once delivery)
client.subscribe(`/devices/${deviceId}/commands/#`, {qos: 0});

// The MQTT topic that this device will publish data to. The MQTT topic name is
// required to be in the format below. The topic name must end in 'state' to
// publish state and 'events' to publish telemetry. Note that this is not the
// same as the device registry's Cloud Pub/Sub topic.
const mqttTopic = `/devices/${deviceId}/${messageType}`;

async function send(data) {
    await client.on('connect', success => {
        console.log('connect');
        if (!success) {
            console.log('Client not connected...');
        } else if (!publishChainInProgress) {
            publishAsync(mqttTopic, client, iatTime, data, 1, connectionArgs);
        }
    });

    await client.on('close', () => {
        console.log('close');
        shouldBackoff = true;
    });

    await client.on('error', err => {
        console.log('error', err);
    });

    await client.on('message', (topic, message) => {
        let messageStr = 'Message received: ';
        if (topic === `/devices/${deviceId}/config`) {
            messageStr = 'Config message received: ';
        } else if (topic.startsWith(`/devices/${deviceId}/commands`)) {
            messageStr = 'Command message received: ';
        }

        messageStr += Buffer.from(message, 'base64').toString('ascii');
        console.log(messageStr);
    });

    await client.on('packetsend', () => {
        // Note: logging packet send is very verbose

    });
}

// Once all of the messages have been published, the connection to Google Cloud
// IoT will be closed and the process will exit. See the publishAsync method.

//[End Example]
const sensor = require("node-dht-sensor").promises;

async function exec() {
    try {
        const res = await sensor.read(11, 4);

        const json = '{ "temp": "'+ res.temperature.toFixed(1) +'" , "hum": "' + res.humidity.toFixed(1) +'"}';
        obj = JSON.parse(json);
        console.log(obj);

    } catch (err) {
        console.error("Failed to read sensor data:", err);
    }
}
send(obj);
setInterval(exec, 10000);


//---



const {argv} = require('yargs')
    .options({
        projectId: {
            default: process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT,
            description:
                'The Project ID to use. Defaults to the value of the GCLOUD_PROJECT or GOOGLE_CLOUD_PROJECT environment variables.',
            requiresArg: true,
            type: 'string',
        },
        cloudRegion: {
            default: 'us-central1',
            description: 'GCP cloud region.',
            requiresArg: true,
            type: 'string',
        },
        registryId: {
            description: 'Cloud IoT registry ID.',
            requiresArg: true,
            demandOption: false,
            type: 'string',
        },
        deviceId: {
            description: 'Cloud IoT device ID.',
            requiresArg: true,
            demandOption: false,
            type: 'string',
        },
        privateKeyFile: {
            description: 'Path to private key file.',
            requiresArg: true,
            demandOption: false,
            type: 'string',
        },
        serverCertFile: {
            description: 'Path to server certificate file.',
            requiresArg: true,
            demandOption: false,
            type: 'string',
        },
        algorithm: {
            description: 'Encryption algorithm to generate the JWT.',
            requiresArg: true,
            demandOption: false,
            choices: ['RS256', 'ES256'],
            type: 'string',
        },
        tokenExpMins: {
            default: 20,
            description: 'Minutes to JWT token expiration.',
            requiresArg: true,
            type: 'number',
        },
        mqttBridgeHostname: {
            default: 'mqtt.googleapis.com',
            description: 'MQTT bridge hostname.',
            requiresArg: true,
            type: 'string',
        },
        mqttBridgePort: {
            default: 8883,
            description: 'MQTT bridge port.',
            requiresArg: true,
            type: 'number',
        },
    })
    .command(
        'mqttDeviceDemo',
        'Connects a device, sends data, and receives data',
        {
            messageType: {
                default: 'events',
                description: 'Message type to publish.',
                requiresArg: true,
                choices: ['events', 'state'],
                type: 'string',
            },
            numMessages: {
                default: 10,
                description: 'Number of messages to publish.',
                demandOption: true,
                type: 'number',
            },
        },
        opts => {
            mqttDeviceDemo(
                opts.deviceId,
                opts.registryId,
                opts.projectId,
                opts.cloudRegion,
                opts.algorithm,
                opts.privateKeyFile,
                opts.serverCertFile,
                opts.mqttBridgeHostname,
                opts.mqttBridgePort,
                opts.messageType,
                opts.numMessages
            );
        }
    )
    .command(
        'sendDataFromBoundDevice',
        'Sends data from a gateway on behalf of a bound device.',
        {
            gatewayId: {
                description: 'Cloud IoT gateway ID.',
                requiresArg: true,
                demandOption: true,
                type: 'string',
            },
            numMessages: {
                default: 10,
                description: 'Number of messages to publish.',
                demandOption: true,
                type: 'number',
            },
        },
        opts => {
            sendDataFromBoundDevice(
                opts.deviceId,
                opts.gatewayId,
                opts.registryId,
                opts.projectId,
                opts.cloudRegion,
                opts.algorithm,
                opts.privateKeyFile,
                opts.serverCertFile,
                opts.mqttBridgeHostname,
                opts.mqttBridgePort,
                opts.numMessages,
                opts.tokenExpMins
            );
        }
    )
    .command(
        'listenForConfigMessages',
        'Listens for configuration changes on a gateway and bound device.',
        {
            gatewayId: {
                description: 'Cloud IoT gateway ID.',
                requiresArg: true,
                demandOption: true,
                type: 'string',
            },
            clientDuration: {
                default: 60000,
                description: 'Duration in milliseconds for MQTT client to run.',
                requiresArg: true,
                type: 'number',
            },
        },
        opts => {
            listenForConfigMessages(
                opts.deviceId,
                opts.gatewayId,
                opts.registryId,
                opts.projectId,
                opts.cloudRegion,
                opts.algorithm,
                opts.privateKeyFile,
                opts.serverCertFile,
                opts.mqttBridgeHostname,
                opts.mqttBridgePort,
                opts.clientDuration
            );
        }
    )
    .command(
        'listenForErrorMessages',
        'Listens for error messages on a gateway.',
        {
            gatewayId: {
                description: 'Cloud IoT gateway ID.',
                requiresArg: true,
                demandOption: true,
                type: 'string',
            },
            clientDuration: {
                default: 60000,
                description: 'Duration in milliseconds for MQTT client to run.',
                requiresArg: true,
                type: 'number',
            },
        },
        opts => {
            listenForErrorMessages(
                opts.deviceId,
                opts.gatewayId,
                opts.registryId,
                opts.projectId,
                opts.cloudRegion,
                opts.algorithm,
                opts.privateKeyFile,
                opts.serverCertFile,
                opts.mqttBridgeHostname,
                opts.mqttBridgePort,
                opts.clientDuration
            );
        }
    )
    .example(
        'node $0 mqttDeviceDemo --projectId=blue-jet-123 \\\n\t--registryId=my-registry --deviceId=my-node-device \\\n\t--privateKeyFile=../rsa_private.pem \\\n\t--serverCertFile=../roots.pem --algorithm=RS256 \\\n\t--cloudRegion=us-central1 --numMessages=10 \\\n'
    )
    .example(
        'node $0 sendDataFromBoundDevice --projectId=blue-jet-123 \\\n\t--registryId=my-registry --deviceId=my-node-device \\\n\t--privateKeyFile=../rsa_private.pem \\\n\t--serverCertFile=../roots.pem --algorithm=RS256 \\\n\t--cloudRegion=us-central1 --gatewayId=my-node-gateway \\\n'
    )
    .example(
        'node $0 listenForConfigMessages --projectId=blue-jet-123 \\\n\t--registryId=my-registry --deviceId=my-node-device \\\n\t--privateKeyFile=../rsa_private.pem \\\n\t--serverCertFile=../roots.pem --algorithm=RS256 \\\n\t--cloudRegion=us-central1 --gatewayId=my-node-gateway \\\n\t--clientDuration=300000 \\\n'
    )
    .example(
        'node $0 listenForErrorMessages --projectId=blue-jet-123 \\\n\t--registryId=my-registry --deviceId=my-node-device \\\n\t--privateKeyFile=../rsa_private.pem \\\n\t--serverCertFile=../roots.pem --algorithm=RS256 \\\n\t--cloudRegion=us-central1 --gatewayId=my-node-gateway \\\n\t--clientDuration=300000 \\\n'
    )
    .wrap(120)
    .recommendCommands()
    .epilogue('For more information, see https://cloud.google.com/iot-core/docs')
    .help()
    .strict();

