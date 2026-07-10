#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h> // Thêm thư viện gọi HTTP
#include <SPI.h>
#include <MFRC522.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>

// Thay IP mạng Wi-Fi bằng IP loopback của Wokwi
const char* serverName = "https://chamcong-sv-nttu.onrender.com";

// Định nghĩa chân kết nối (Giữ nguyên cấu hình cũ)
#define SS_PIN 5
#define RST_PIN 4
#define LED_GREEN 12
#define LED_RED 14
#define BUZZER 13

MFRC522 rfid(SS_PIN, RST_PIN);
LiquidCrystal_I2C lcd(0x27, 16, 2);

void displayReady();
void successFeedback();
void errorFeedback();

void setup() {
  Serial.begin(115200);
  
  pinMode(LED_GREEN, OUTPUT);
  pinMode(LED_RED, OUTPUT);
  pinMode(BUZZER, OUTPUT);
  digitalWrite(LED_GREEN, LOW);
  digitalWrite(LED_RED, LOW);
  digitalWrite(BUZZER, LOW);

  lcd.init();
  lcd.backlight();
  lcd.setCursor(0, 0);
  lcd.print("Dang ket noi WiFi...");

  SPI.begin();
  rfid.PCD_Init();

  // Kết nối WiFi Wokwi
  WiFi.begin("Wokwi-GUEST", "", 6);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  
  // Bỏ qua toàn bộ phần đồng bộ NTP và SSL vì chúng ta gọi HTTP local
  Serial.println("\n[Thành công] Đã kết nối WiFi cục bộ.");
  displayReady();
}

void loop() {
  // Đọc thẻ RFID
  if (!rfid.PICC_IsNewCardPresent() || !rfid.PICC_ReadCardSerial())
    return;

  String uidStr = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    uidStr += String(rfid.uid.uidByte[i] < 0x10 ? "0" : "");
    uidStr += String(rfid.uid.uidByte[i], HEX);
  }
  uidStr.toUpperCase();
  
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("UID: " + uidStr);
  lcd.setCursor(0, 1);
  lcd.print("Dang gui API...");
  Serial.println("\nQuét được thẻ UID: " + uidStr);

  // Gửi HTTP POST lên Server Node.js
  if (WiFi.status() == WL_CONNECTED) {
    HTTPClient http;
    http.begin(serverName); // Khởi tạo kết nối tới Node.js API
    
    // Khai báo Header là JSON
    http.addHeader("Content-Type", "application/json");

    // Tạo chuỗi JSON thủ công cực nhẹ: {"uid":"E3F2A1B2"}
    String httpRequestData = "{\"uid\":\"" + uidStr + "\"}";
    
    // Gửi request
    int httpResponseCode = http.POST(httpRequestData);
    
    if (httpResponseCode == 200 || httpResponseCode == 201) {
      Serial.print("Đẩy dữ liệu thành công. HTTP Code: ");
      Serial.println(httpResponseCode);
      successFeedback();
    } else {
      Serial.print("Lỗi từ Server. HTTP Code: ");
      Serial.println(httpResponseCode);
      errorFeedback();
    }
    
    http.end(); // Giải phóng tài nguyên
  } else {
    Serial.println("Lỗi mất kết nối WiFi");
    errorFeedback();
  }
  
  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  
  delay(2000); 
  displayReady(); 
}

void displayReady() {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("He thong D.Danh");
  lcd.setCursor(0, 1);
  lcd.print("Moi quet the...");
}

void successFeedback() {
  lcd.setCursor(0, 1);
  lcd.print("Thanh cong!     ");
  
  // Bật LED xanh và còi
  digitalWrite(LED_GREEN, HIGH);
  digitalWrite(BUZZER, HIGH); 
  
  delay(200); // Kêu bíp ngắn 0.2s
  
  // Tắt LED và còi
  digitalWrite(BUZZER, LOW);
  digitalWrite(LED_GREEN, LOW);
}

void errorFeedback() {
  lcd.setCursor(0, 1);
  lcd.print("Loi ket noi!    ");
  
  // Bật LED đỏ và còi
  digitalWrite(LED_RED, HIGH);
  digitalWrite(BUZZER, HIGH); 
  
  delay(1000); // Kêu bíp dài 1s
  
  // Tắt LED và còi
  digitalWrite(BUZZER, LOW);
  digitalWrite(LED_RED, LOW);
}